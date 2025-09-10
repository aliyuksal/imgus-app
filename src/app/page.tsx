// src/app/page.tsx
import Link from "next/link";

export default function Home() {
  return (
    <main style={{ padding: 24 }}>
      <h1>Imgus</h1>
      <p><Link href="/api/auth/signin">Giriş yap</Link></p>
    </main>
  );
}