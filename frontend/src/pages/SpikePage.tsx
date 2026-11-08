import { useState } from "react";
import { runSpike, runPersistentSpike, type PersistentSpikeResult } from "../crypto/spike";

export function SpikePage() {
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<{ library: string; decrypted: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [isPersistentRunning, setIsPersistentRunning] = useState(false);
  const [persistentResult, setPersistentResult] = useState<PersistentSpikeResult | null>(null);
  const [persistentError, setPersistentError] = useState<string | null>(null);

  const handleRunSpike = async () => {
    setIsRunning(true);
    setError(null);
    try {
      const res = await runSpike();
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      setIsRunning(false);
    }
  };

  const handleRunPersistentSpike = async () => {
    setIsPersistentRunning(true);
    setPersistentError(null);
    try {
      const res = await runPersistentSpike();
      setPersistentResult(res);
    } catch (err) {
      setPersistentError(err instanceof Error ? err.message : String(err));
      setPersistentResult(null);
    } finally {
      setIsPersistentRunning(false);
    }
  };

  return (
    <section className="card">
      <h1>Signal Protocol Spike</h1>
      <p className="muted">Proving that the Signal Protocol runs in the browser under Vite.</p>

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={handleRunSpike}
          disabled={isRunning}
          style={{
            padding: "0.5rem 1rem",
            cursor: isRunning ? "not-allowed" : "pointer",
            fontWeight: 600,
          }}
        >
          {isRunning ? "Running..." : "Run spike"}
        </button>

        <button
          type="button"
          onClick={handleRunPersistentSpike}
          disabled={isPersistentRunning}
          style={{
            padding: "0.5rem 1rem",
            cursor: isPersistentRunning ? "not-allowed" : "pointer",
            fontWeight: 600,
          }}
        >
          {isPersistentRunning ? "Running..." : "Run persistent spike"}
        </button>
      </div>

      {result && (
        <div style={{ marginTop: "1rem" }} data-testid="spike-result">
          <h3>In-memory Spike Result</h3>
          <p>
            <strong>Library:</strong> <code>{result.library}</code>
          </p>
          <p>
            <strong>Decrypted:</strong> <code>{result.decrypted}</code>
          </p>
        </div>
      )}

      {error && (
        <div style={{ marginTop: "1rem", color: "var(--red)" }} data-testid="spike-error">
          <p>
            <strong>Error:</strong> {error}
          </p>
        </div>
      )}

      {persistentResult && (
        <div style={{ marginTop: "1rem" }} data-testid="persistent-spike-result">
          <h3>Persistent Spike Result (IndexedDB + X3DH)</h3>
          <p>
            <strong>Library:</strong> <code>{persistentResult.library}</code>
          </p>
          <p>
            <strong>Bob received:</strong> <code>{persistentResult.bobDecrypted}</code> (Envelope type: {persistentResult.aliceToBobEnvelopeType})
          </p>
          <p>
            <strong>Alice received:</strong> <code>{persistentResult.aliceDecrypted}</code> (Envelope type: {persistentResult.bobToAliceEnvelopeType})
          </p>
        </div>
      )}

      {persistentError && (
        <div style={{ marginTop: "1rem", color: "var(--red)" }} data-testid="persistent-spike-error">
          <p>
            <strong>Persistent Error:</strong> {persistentError}
          </p>
        </div>
      )}
    </section>
  );
}
