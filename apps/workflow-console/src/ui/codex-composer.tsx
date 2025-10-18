import { FormEvent, useEffect, useState } from 'react';
import type {
  CodexPrompt,
  CodexStreamHandle,
  CodexSuggestionStream,
} from '../types/canon';
import { CodexAdapter } from '../services/codex-adapter';
import { TelemetryHub } from '../services/telemetry';

interface CodexComposerProps {
  adapter: CodexAdapter;
  telemetry: TelemetryHub;
}

export function CodexComposer({ adapter, telemetry }: CodexComposerProps) {
  const [intent, setIntent] = useState<CodexPrompt['intent']>('draft_brief');
  const [input, setInput] = useState('');
  const [stream, setStream] = useState<CodexSuggestionStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftHandle, setDraftHandle] = useState<CodexStreamHandle | null>(null);
  const [publishMessage, setPublishMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!draftHandle) return;
    const unsubscribe = draftHandle.subscribe((next) => setStream(next));
    return () => {
      unsubscribe();
    };
  }, [draftHandle]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const handle = adapter.generate({
        intent,
        input,
        sessionId: 'local-session',
      });
      setDraftHandle(handle);
      setStream(handle.stream);
      setError(null);
      setPublishMessage(null);
      telemetry.track('codex', 'codex.request', {
        intent,
        size: input.length,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRedact = () => {
    if (!draftHandle) return;
    const redacted = draftHandle.redact();
    setStream(redacted);
    setPublishMessage('Draft redacted.');
  };

  const handlePublish = () => {
    if (!draftHandle) return;
    const receipt = draftHandle.publishDraft();
    setPublishMessage(`Draft published to audit ${receipt.auditId}.`);
  };

  return (
    <form className="tm-codex" onSubmit={handleSubmit}>
      <header>
        <h2>Codex composer</h2>
      </header>
      <label>
        Intent
        <select value={intent} onChange={(event) => setIntent(event.target.value as CodexPrompt['intent'])}>
          <option value="draft_brief">Draft brief</option>
          <option value="draft_requirement">Draft requirement</option>
          <option value="draft_note">Draft note</option>
        </select>
      </label>
      <label>
        Prompt
        <textarea value={input} onChange={(event) => setInput(event.target.value)} />
      </label>
      <button type="submit">Request assistance</button>
      {error ? <p className="tm-codex__error">{error}</p> : null}
      {stream ? (
        <section className="tm-codex__suggestions">
          <h3>Suggestions</h3>
          <ul>
            {stream.suggestions.map((suggestion) => (
              <li key={suggestion.id}>{suggestion.content}</li>
            ))}
          </ul>
          <div className="tm-codex__actions">
            <button type="button" onClick={handleRedact} disabled={!draftHandle}>
              Redact draft
            </button>
            <button type="button" onClick={handlePublish} disabled={!draftHandle}>
              Publish draft
            </button>
          </div>
          {publishMessage ? <p className="tm-codex__status">{publishMessage}</p> : null}
        </section>
      ) : null}
    </form>
  );
}
