import * as NodeHttp from "node:http";

export interface HealthState {
  live: boolean;
  ready: boolean;
  reason: string | null;
}

export function startHealthServer(input: {
  readonly host: string;
  readonly port: number;
  readonly state: () => HealthState;
}): NodeHttp.Server {
  const server = NodeHttp.createServer((request, response) => {
    const state = input.state();
    const isReadyRequest = request.url === "/ready";
    const ok = isReadyRequest ? state.ready : state.live;
    response.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify(state));
  });
  server.listen(input.port, input.host);
  return server;
}
