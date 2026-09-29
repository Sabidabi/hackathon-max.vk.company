import { Link } from "react-router-dom";

import "./landing.css";

// Seeded by `backend/app/demo_data.py` (DEMO_PUBLIC_ID).
const DEMO_PUBLIC_ID = "demo-sever";

/**
 * `/` in an ordinary browser. Interim landing for the router milestone; the full
 * product landing with a live demo is the Landing epic (E3, P1-DOC-5).
 */
export default function LandingSurface() {
  return (
    <main className="landing-stub">
      <section className="landing-stub-card" aria-labelledby="landing-title">
        <p className="landing-stub-kicker">Мини-приложение MAX для кофеен</p>
        <h1 id="landing-title">Синица</h1>
        <p>Гость открывает меню по QR-коду, администратор обновляет его за минуту — прямо в MAX.</p>
        <div className="landing-stub-actions">
          <Link className="landing-stub-primary" to={`/r/${DEMO_PUBLIC_ID}`}>Открыть демо-меню</Link>
          <Link className="landing-stub-secondary" to="/manage">Кабинет заведения</Link>
        </div>
      </section>
    </main>
  );
}
