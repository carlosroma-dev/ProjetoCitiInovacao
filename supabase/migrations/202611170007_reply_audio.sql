alter table patio_voz.elevenlabs_turn_usage
  add column audio_mp3 bytea,
  add column audio_claim_until timestamptz;

alter table patio_voz.visits add column turn_wants_audio boolean;
