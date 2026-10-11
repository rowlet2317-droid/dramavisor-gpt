"use client";

import { FormEvent, use, useState } from "react";

export default function AcceptInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");

  async function acceptInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/api/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    if (response.ok) {
      window.location.assign("/");
      return;
    }
    const result = await response.json() as { error?: string };
    setMessage(result.error ?? "Unable to accept invite");
  }

  return (
    <main>
      <h1>Accept your invite</h1>
      <form action="/api/auth/accept-invite" method="post" onSubmit={acceptInvite}>
        <input type="hidden" name="token" value={token} />
        <label htmlFor="password">Choose a password</label>
        <input
          id="password"
          name="password"
          type="password"
          minLength={12}
          required
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="submit" data-native-submit="true">Create account</button>
      </form>
      {message ? <p role="alert">{message}</p> : null}
    </main>
  );
}
