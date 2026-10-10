// Tiny SMTP sink for the compat suite (no dependencies). Runs in a throwaway container attached to the project's
// egress network so GoTrue can deliver confirmation / OTP mails to it; the suite reads them over HTTP.
//   SMTP :2525 (no TLS, no auth)        HTTP :8025  GET /messages → [{ from, to, data, at }]   DELETE /messages
import net from "node:net";
import http from "node:http";

const messages = [];

net
  .createServer((sock) => {
    let buf = "";
    let mode = "cmd";
    let msg = { from: "", to: [], data: "" };
    const say = (s) => sock.write(s + "\r\n");
    say("220 compat-smtp ESMTP sink");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (mode === "data") {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          msg.data = buf.slice(0, end).replace(/^\.\./gm, ".");
          buf = buf.slice(end + 5);
          messages.push({ ...msg, at: new Date().toISOString() });
          msg = { from: "", to: [], data: "" };
          mode = "cmd";
          say("250 OK queued");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") sock.write("250-compat-smtp\r\n250-8BITMIME\r\n250 SIZE 10485760\r\n");
        else if (cmd === "HELO") say("250 compat-smtp");
        else if (cmd === "MAIL") (msg.from = line.replace(/^MAIL FROM:\s*/i, "")), say("250 OK");
        else if (cmd === "RCPT") msg.to.push(line.replace(/^RCPT TO:\s*/i, "")), say("250 OK");
        else if (cmd === "DATA") (mode = "data"), say("354 End data with <CR><LF>.<CR><LF>");
        else if (cmd === "RSET") (msg = { from: "", to: [], data: "" }), say("250 OK");
        else if (cmd === "NOOP") say("250 OK");
        else if (cmd === "QUIT") say("221 Bye"), sock.end();
        else say("502 Command not implemented");
      }
    });
    sock.on("error", () => {});
  })
  .listen(2525, () => console.log("smtp sink on :2525"));

http
  .createServer((req, res) => {
    if (req.method === "DELETE") messages.length = 0;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(messages));
  })
  .listen(8025, () => console.log("http on :8025"));
