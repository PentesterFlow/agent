import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function listenOnLocalhost(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('error', onError);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(
        new Error(
          `test HTTP server failed to listen on 127.0.0.1: ${
            (err as NodeJS.ErrnoException).code ?? err.message
          }`,
        ),
      );
    };

    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      cleanup();
      resolve((server.address() as AddressInfo).port);
    });
  });
}
