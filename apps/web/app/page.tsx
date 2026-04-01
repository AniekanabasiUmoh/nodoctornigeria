import { Chat } from "@/components/Chat";
import { Nav } from "@/components/Nav";
import styles from "./page.module.css";

export default function Home() {
  return (
    <>
      <Nav />
      <main className={styles.main}>
        <header className={styles.hero}>
          <p className={styles.eyebrow}>Nigeria Standard Treatment Guidelines</p>
          <h1 className={styles.heading}>
            When there is<br />no doctor.
          </h1>
          <p className={styles.sub}>
            Ask any health question. Every answer comes from the national clinical guidelines — nothing invented.
          </p>
        </header>
        <Chat />
      </main>
      <footer className={styles.footer}>
        <span>nodoctor.ng &mdash; Beta</span>
        <span>Powered by Nigeria Standard Treatment Guidelines</span>
      </footer>
    </>
  );
}
