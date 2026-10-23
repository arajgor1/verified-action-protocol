import http from "node:http";
import net from "node:net";

/**
 * Minimal forward proxy that all browser traffic goes through. It is the browser adapter's
 * egress control: only the approved origin is reachable, and connections go to the address
 * that was checked against the network policy when the adapter started (so DNS rebinding,
 * redirects to other hosts, IP-literal hops and sub-resources elsewhere all fail with 403).
 * WebSocket upgrades are refused. It listens on loopback only.
 */
export interface EgressProxy {
  url: string;
  close(): Promise<void>;
}

const HOP_BY_HOP = ["proxy-connection", "proxy-authorization", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade"];

export async function startEgressProxy(origin: URL, connectAddress: string): Promise<EgressProxy> {
  const httpsPort = origin.port || (origin.protocol === "https:" ? "443" : "80");
  const tunnelTarget = `${origin.hostname}:${httpsPort}`;
  const server = http.createServer((req, res) => {
    let u: URL;
    try {
      u = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (u.protocol !== "http:" || origin.protocol !== "http:" || u.host !== origin.host) {
      res.writeHead(403, { "content-type": "text/plain" }).end("blocked by VAP egress policy");
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.includes(k)) headers[k] = v;
    headers.host = origin.host;
    const upstream = http.request(
      { host: connectAddress, port: Number(httpsPort), method: req.method, path: u.pathname + u.search, headers, agent: false },
      (r) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(r.headers)) if (!HOP_BY_HOP.includes(k)) out[k] = v;
        res.writeHead(r.statusCode ?? 502, out);
        r.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  // HTTPS tunnels: only to the approved host and port, connected to the checked address.
  server.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    if (origin.protocol !== "https:" || req.url !== tunnelTarget) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(Number(httpsPort), connectAddress, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  server.on("upgrade", (_req: http.IncomingMessage, socket: net.Socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
