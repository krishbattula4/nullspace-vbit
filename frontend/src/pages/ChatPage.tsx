import { useParams } from "react-router-dom";

export function ChatPage() {
  const { conversationId } = useParams();
  // P2.6 builds the conversation list, chat view and composer here.
  return (
    <section className="card">
      <h1>Chat</h1>
      <p className="muted">
        {conversationId ? `Conversation ${conversationId}` : "No conversation selected."} Implemented in
        task P2.6.
      </p>
    </section>
  );
}
