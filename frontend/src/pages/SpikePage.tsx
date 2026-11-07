import { useState } from "react";
import { runSpike } from "../crypto/spike";

export function SpikePage() {
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<{ library: string; decrypted: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <section className="card">
      <h1>Signal Protocol Spike</h1>
      <p className="muted">Proving that the Signal Protocol runs in the browser under Vite.</p>

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

      {result && (
        <div style={{ marginTop: "1rem" }} data-testid="spike-result">
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
    </section>
  );
}
