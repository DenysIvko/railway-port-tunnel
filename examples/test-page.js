const http = require("node:http");

const port = Number(process.env.PORT || 3500);

const server = http.createServer((request, response) => {
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Tunnel Demo</title>
    <style>
      body {
        font-family: sans-serif;
        max-width: 720px;
        margin: 48px auto;
        padding: 0 20px;
        line-height: 1.5;
      }
      code {
        background: #f4f4f4;
        padding: 2px 6px;
        border-radius: 4px;
      }
    </style>
  </head>
  <body>
    <h1>Tunnel Demo</h1>
    <p>This page is being served from your local machine through the tunnel.</p>
    <p>Requested path: <code>${request.url}</code></p>
  </body>
</html>`);
});

server.listen(port, () => {
  process.stdout.write(`Demo page listening on http://127.0.0.1:${port}\n`);
});
