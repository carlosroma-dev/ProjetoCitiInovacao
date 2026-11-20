import VoiceChat from "./voice-chat";

export default async function DemoRoundPage({ params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params;
  return <VoiceChat key={roundId} roundId={roundId} />;
}
