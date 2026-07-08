'use client';

import { useState } from 'react';

interface Message {
  role: 'q' | 'a';
  text: string;
}

export default function Chat({ channelId }: { channelId: number }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);

  async function ask() {
    const q = question.trim();
    if (!q || busy) return;
    setQuestion('');
    setMessages((m) => [...m, { role: 'q', text: q }]);
    setBusy(true);
    try {
      const res = await fetch(`/api/channels/${channelId}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const body = await res.json();
      const answer = res.ok ? body.answer : `Error: ${body.error ?? res.status}`;
      setMessages((m) => [...m, { role: 'a', text: answer }]);
    } catch (err) {
      setMessages((m) => [...m, { role: 'a', text: `Error: ${String(err)}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="chat-log">
        {messages.length === 0 && (
          <p className="muted" style={{ margin: 0 }}>
            Ask anything about the researched apps — e.g. “which apps crossed $20k MRR and how did
            they get distribution?”
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            {m.text}
          </div>
        ))}
        {busy && <div className="chat-msg a muted">Thinking…</div>}
      </div>
      <div className="row">
        <textarea
          rows={2}
          placeholder="Ask about the findings…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              ask();
            }
          }}
        />
        <button onClick={ask} disabled={busy || !question.trim()}>
          Ask
        </button>
      </div>
    </div>
  );
}
