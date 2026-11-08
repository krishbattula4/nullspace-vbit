import { useState } from "react";
import {
  runSpike,
  runPersistentSpike,
  runKeyChangeSpike,
  type PersistentSpikeResult,
  type KeyChangeSpikeResult,
} from "../crypto/spike";

export function SpikePage() {
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<{ library: string; decrypted: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [isPersistentRunning, setIsPersistentRunning] = useState(false);
  const [persistentResult, setPersistentResult] = useState<PersistentSpikeResult | null>(null);
  const [persistentError, setPersistentError] = useState<string | null>(null);

  const [isKeyChangeRunning, setIsKeyChangeRunning] = useState(false);
  const [keyChangeResult, setKeyChangeResult] = useState<KeyChangeSpikeResult | null>(null);
  const [keyChangeError, setKeyChangeError] = useState<string | null>(null);

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

  const handleRunKeyChangeSpike = async () => {
    setIsKeyChangeRunning(true);
    setKeyChangeError(null);
    try {
      const res = await runKeyChangeSpike();
      setKeyChangeResult(res);
    } catch (err) {
      setKeyChangeError(err instanceof Error ? err.message : String(err));
      setKeyChangeResult(null);
    } finally {
      setIsKeyChangeRunning(false);
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

        <button
          type="button"
          onClick={handleRunKeyChangeSpike}
          disabled={isKeyChangeRunning}
          style={{
            padding: "0.5rem 1rem",
            cursor: isKeyChangeRunning ? "not-allowed" : "pointer",
            fontWeight: 600,
          }}
        >
          {isKeyChangeRunning ? "Running..." : "Simulate key change on Bob"}
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
          {persistentResult.aliceSafetyNumberFormatted && persistentResult.bobSafetyNumberFormatted && (
            <div style={{ marginTop: "1rem" }} data-testid="safety-number-result">
              <h4>Safety Number Verification</h4>
              <p>
                <strong>Alice's safety number with Bob:</strong>
              </p>
              <pre
                data-testid="alice-safety-number"
                style={{
                  background: "#1e1e1e",
                  color: "#e0e0e0",
                  padding: "0.75rem",
                  borderRadius: "6px",
                  fontFamily: "monospace",
                  whiteSpace: "pre",
                }}
              >
                {persistentResult.aliceSafetyNumberFormatted}
              </pre>
              <p>
                <strong>Bob's safety number with Alice:</strong>
              </p>
              <pre
                data-testid="bob-safety-number"
                style={{
                  background: "#1e1e1e",
                  color: "#e0e0e0",
                  padding: "0.75rem",
                  borderRadius: "6px",
                  fontFamily: "monospace",
                  whiteSpace: "pre",
                }}
              >
                {persistentResult.bobSafetyNumberFormatted}
              </pre>
              <p>
                <strong>Verification status:</strong>{" "}
                <span
                  data-testid="safety-number-status"
                  style={{
                    fontWeight: 700,
                    color: persistentResult.safetyNumbersMatch ? "#4caf50" : "#f44336",
                  }}
                >
                  {persistentResult.safetyNumbersMatch ? "match" : "MISMATCH"}
                </span>
              </p>
            </div>
          )}
        </div>
      )}

      {persistentError && (
        <div style={{ marginTop: "1rem", color: "var(--red)" }} data-testid="persistent-spike-error">
          <p>
            <strong>Persistent Error:</strong> {persistentError}
          </p>
        </div>
      )}

      {keyChangeResult && (
        <div style={{ marginTop: "1rem" }} data-testid="key-change-spike-result">
          <h3>Key Change Simulation Result</h3>
          <p>
            <strong>Alice decrypted message:</strong>{" "}
            <span
              data-testid="key-change-decrypted-status"
              style={{
                fontWeight: 700,
                color: keyChangeResult.decryptedSuccess ? "#4caf50" : "#f44336",
              }}
            >
              {keyChangeResult.decryptedSuccess ? `Yes ("${keyChangeResult.aliceDecrypted}")` : "No"}
            </span>
          </p>
          <p>
            <strong>Alice's verification state for Bob:</strong>{" "}
            <span
              data-testid="key-change-verification-state"
              style={{
                fontWeight: 700,
                color:
                  keyChangeResult.stateLabelColour === "red"
                    ? "#f44336"
                    : keyChangeResult.stateLabelColour === "green"
                    ? "#4caf50"
                    : "#ff9800",
              }}
            >
              {keyChangeResult.stateLabelText}
            </span>
          </p>
          <p>
            <strong>KeyChangeEvent direction:</strong>{" "}
            <code data-testid="key-change-event-direction">{keyChangeResult.eventDirection}</code>
          </p>
          {keyChangeResult.safetyNumberBeforeFormatted && keyChangeResult.safetyNumberAfterFormatted && (
            <div style={{ marginTop: "1rem" }}>
              <h4>Safety Number Comparison</h4>
              <p>
                <strong>Safety number before key change:</strong>
              </p>
              <pre
                data-testid="safety-number-before"
                style={{
                  background: "#1e1e1e",
                  color: "#e0e0e0",
                  padding: "0.75rem",
                  borderRadius: "6px",
                  fontFamily: "monospace",
                  whiteSpace: "pre",
                }}
              >
                {keyChangeResult.safetyNumberBeforeFormatted}
              </pre>
              <p>
                <strong>Safety number after key change:</strong>
              </p>
              <pre
                data-testid="safety-number-after"
                style={{
                  background: "#1e1e1e",
                  color: "#e0e0e0",
                  padding: "0.75rem",
                  borderRadius: "6px",
                  fontFamily: "monospace",
                  whiteSpace: "pre",
                }}
              >
                {keyChangeResult.safetyNumberAfterFormatted}
              </pre>
              <p>
                <strong>Safety numbers differ:</strong>{" "}
                <span
                  data-testid="safety-numbers-differ-status"
                  style={{
                    fontWeight: 700,
                    color: keyChangeResult.safetyNumbersDiffer ? "#4caf50" : "#f44336",
                  }}
                >
                  {keyChangeResult.safetyNumbersDiffer ? "Yes (differ)" : "No (identical)"}
                </span>
              </p>
            </div>
          )}
        </div>
      )}

      {keyChangeError && (
        <div style={{ marginTop: "1rem", color: "var(--red)" }} data-testid="key-change-spike-error">
          <p>
            <strong>Key Change Error:</strong> {keyChangeError}
          </p>
        </div>
      )}
    </section>
  );
}
