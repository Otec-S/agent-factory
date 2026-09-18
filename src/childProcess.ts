import { fork, spawnSync, type ChildProcess } from 'node:child_process';

/** Сообщения родитель -> дочерний процесс. */
type ParentMessage<I> = { type: 'run'; input: I } | { type: 'abort' };

const ABORT_GRACE_MS = 5_000;

/**
 * Убивает процесс вместе с потомками. Agent SDK запускает отдельный CLI-процесс,
 * и простой child.kill() на Windows оставил бы его сиротой, продолжающим писать в workdir.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

export type RunChildOptions<I, R> = {
  entry: string;
  input: I;
  timeoutSec: number;
  onTimeout: () => R;
  onFailure: (message: string) => R;
};

/**
 * Форкает процесс, отправляет ему вход и ждёт один результат по IPC. Никогда не
 * отклоняет промис: любой сбой нормализуется через onFailure/onTimeout.
 * По таймауту сначала просит процесс прервать запрос к модели, а если он не вышел
 * за ABORT_GRACE_MS — убивает дерево процессов. Промис разрешается только после
 * фактического выхода процесса, чтобы следующий воркер не стартовал рядом с "зомби".
 */
export function runChild<I, R>(opts: RunChildOptions<I, R>): Promise<R> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = fork(opts.entry, [], { stdio: 'inherit' });
    } catch (err) {
      resolve(opts.onFailure(err instanceof Error ? err.message : String(err)));
      return;
    }

    let result: R | undefined;
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (value: R) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.connected) child.send({ type: 'abort' } satisfies ParentMessage<I>);
      killTimer = setTimeout(() => killTree(child), ABORT_GRACE_MS);
    }, opts.timeoutSec * 1000);

    child.on('message', (msg: R) => {
      if (!timedOut && result === undefined) result = msg;
    });

    // 'close' (а не 'exit') приходит после того, как закрыт IPC-канал, т.е. все сообщения уже доставлены.
    child.once('close', (code) => {
      if (timedOut) finish(opts.onTimeout());
      else if (result !== undefined) finish(result);
      else finish(opts.onFailure(`процесс завершился без результата (code ${code})`));
    });

    child.once('error', (err) => {
      // Если процесс так и не запустился, 'close' может не прийти — разрешаемся здесь.
      if (child.pid === undefined) finish(opts.onFailure(err.message));
    });

    child.send({ type: 'run', input: opts.input } satisfies ParentMessage<I>);
  });
}

/**
 * Сторона дочернего процесса: ждёт 'run', выполняет handler и отправляет результат.
 * process.exit вызывается только в колбэке send — иначе асинхронное IPC-сообщение
 * может потеряться, и родитель решит, что процесс ушёл без результата.
 */
export function serveChild<I, R>(handler: (input: I, abortController: AbortController) => Promise<R>, exitCodeOf: (result: R) => number): void {
  if (typeof process.send !== 'function') return;

  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());

  process.on('message', async (msg: ParentMessage<I>) => {
    if (msg.type === 'abort') {
      controller.abort();
      return;
    }
    const result = await handler(msg.input, controller);
    process.send!(result, undefined, undefined, () => process.exit(exitCodeOf(result)));
  });
}
