import { createServer } from "http";

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body || undefined,
      })
    );
  });
}).listen(80, () => console.log("[echo] listening on :80"));
