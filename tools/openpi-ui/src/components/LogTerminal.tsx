import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, openLogSocket } from '../api/client';

export const LogTerminal: React.FC<{ jobId: string }> = ({ jobId }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      convertEol: true,
      scrollback: 50000,
      fontFamily: 'ui-monospace, Menlo, monospace',
      fontSize: 12,
      theme: { background: '#0b0e14', foreground: '#cbd5e1' }
    });
    
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    let ws: WebSocket | null = null;
    let reconnectAttempts = 0;
    const maxAttempts = 5;
    let userScrolled = false;
    let offset = 0;
    let pollTimer: number | null = null;
    let httpHasWritten = false;
    const byteLength = (s: string) => new TextEncoder().encode(s).length;
    const setOffset = (nextOffset: number) => {
      if (Number.isFinite(nextOffset) && nextOffset >= 0) {
        offset = nextOffset;
      }
    };
    const writeLog = (data: string) => {
      if (!data) return;
      term.write(data, () => {
        if (!userScrolled) {
          term.scrollToBottom();
        }
      });
    };

    term.onScroll((pos) => {
      const isAtBottom = pos >= term.buffer.active.baseY - 5;
      userScrolled = !isAtBottom;
    });

    const connect = () => {
      ws = openLogSocket(jobId, {
        onData: (data) => {
          if (httpHasWritten) return;
          setOffset(offset + byteLength(data));
          writeLog(data);
        },
        onStatus: () => {},
        onEnd: () => {
          term.write('\n\r[Connection Closed]\n\r');
        }
      });

      ws.onclose = (e) => {
        if (reconnectAttempts < maxAttempts && !e.wasClean) {
          reconnectAttempts++;
          setTimeout(connect, Math.min(1000 * Math.pow(2, reconnectAttempts), 10000));
        }
      };
    };

    connect();
    const poll = async () => {
      try {
        if (!Number.isFinite(offset) || offset < 0) return;
        const res = await api.getJobLog(jobId, offset);
        if (res.chunk) {
          setOffset(res.nextByte);
          httpHasWritten = true;
          writeLog(res.chunk);
        }
      } catch {}
    };
    poll();
    pollTimer = window.setInterval(poll, 2000);

    return () => {
      resizeObserver.disconnect();
      if (pollTimer !== null) window.clearInterval(pollTimer);
      if (ws) ws.close();
      term.dispose();
    };
  }, [jobId]);

  return <div ref={containerRef} style={{ flex: 1, minHeight: 0, width: '100%', overflow: 'hidden' }} />;
};
