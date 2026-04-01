import styles from "./Nav.module.css";

export function Nav() {
  return (
    <nav className={styles.nav}>
      <a href="/" className={styles.brand}>
        <span className={styles.logo}>N</span>
        <span className={styles.name}>
          no<strong>doctor</strong>.ng
        </span>
      </a>
      <span className={styles.badge}>Beta</span>
    </nav>
  );
}
