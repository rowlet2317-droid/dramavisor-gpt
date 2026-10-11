ALTER TABLE normalized_audio_artifacts
  DROP CONSTRAINT normalized_audio_artifacts_canonical_key_check;
ALTER TABLE normalized_audio_artifacts
  ADD CONSTRAINT normalized_audio_artifacts_compatible_key_check CHECK (
    canonical_object_key =
      'users/' || owner_user_id::text ||
      '/plays/' || play_id::text ||
      '/takes/' || take_id::text ||
      '/transcripts/' || transcript_id::text || '/normalized.wav'
    OR canonical_object_key LIKE
      'users/' || owner_user_id::text ||
      '/plays/' || play_id::text ||
      '/takes/' || take_id::text ||
      '/transcripts/' || transcript_id::text || '/normalized/%.wav'
  );
