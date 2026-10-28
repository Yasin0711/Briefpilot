// Test des E-Mail-Versands gegen einen kleinen Test-Mailserver.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { smtpSend } from '../server/lib/mail.js';

test('SMTP: Anmeldung und Versand einer UTF-8-Nachricht', async () => {
  const log = [];
  let data = '';
  const server = net.createServer((socket) => {
    let inData = false;
    socket.write('220 test ESMTP\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 OK queued\r\n');
          } else data += `${line}\n`;
          continue;
        }
        log.push(line);
        if (line.startsWith('EHLO')) socket.write('250-test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (line.startsWith('AUTH PLAIN')) socket.write('235 OK\r\n');
        else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) socket.write('250 OK\r\n');
        else if (line === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (line === 'QUIT') socket.end('221 bye\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await smtpSend(
      { host: '127.0.0.1', port: server.address().port, security: 'none', user: 'u', pass: 'p', from: 'BriefPilot <noreply@example.org>' },
      { to: 'lena@example.org', subject: 'Erinnerung: Frist läuft ab', text: 'Grüße\n.Punkt am Zeilenanfang' }
    );
    assert.ok(log.includes('MAIL FROM:<noreply@example.org>'));
    assert.ok(log.includes('RCPT TO:<lena@example.org>'));
    assert.match(data, /Subject: =\?UTF-8\?B\?/);
    const body = data.split('\n\n')[1].replace(/\s+/g, '');
    assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Grüße\r\n.Punkt am Zeilenanfang');
  } finally {
    server.close();
  }
});
