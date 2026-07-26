const stats = [
  ["$48.2M", "Capital committed"],
  ["126", "Projects launched"],
  ["94%", "Successful closes"],
  ["38K", "Active participants"],
];

const steps = [
  {
    number: "01",
    title: "Discover with conviction.",
    text: "Explore a considered register of emerging projects, each presented with clear terms, essential context, and a visible path forward.",
  },
  {
    number: "02",
    title: "Commit on your terms.",
    text: "Choose your allocation and participate through a deliberate, transparent process designed to keep every decision in view.",
  },
  {
    number: "03",
    title: "Move forward together.",
    text: "Follow the project beyond the raise with enduring access to milestones, distributions, and the community around the work.",
  },
];

const principles = [
  {
    label: "For founders",
    title: "A launch should begin with clarity.",
    text: "Purpose-built tools carry your project from first announcement to final allocation. Thoughtful mechanics, measured momentum, and fewer distractions let the work speak for itself.",
    note: "Structured launches · Transparent terms · Enduring community",
  },
  {
    label: "For participants",
    title: "Signal, without the noise.",
    text: "Every opportunity is framed around what matters: the thesis, the terms, the people, and the progress. Considered access replaces the usual rush of disconnected information.",
    note: "Curated access · Verifiable progress · Clear allocations",
  },
  {
    label: "For the long term",
    title: "Built beyond the first day.",
    text: "The raise is only a beginning. @thru creates an intelligible record of launches and an ongoing place for founders and early believers to remain aligned.",
    note: "Ongoing reporting · Shared context · Durable relationships",
  },
];

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="@thru home">
          <span>@</span>thru
        </a>
        <nav className="main-nav" aria-label="Main navigation">
          <a href="#process">Process</a>
          <a href="#principles">Principles</a>
        </nav>
        <div className="header-actions">
          <a className="sign-in" href="#signin">Sign in</a>
          <a className="button button-small" href="#launch">
            Launch App <Arrow />
          </a>
        </div>
      </header>

      <section className="hero section-shell" id="top">
        <div className="eyebrow">
          <span>Independent launch infrastructure</span>
          <span>Est. 2026</span>
        </div>
        <div className="hero-grid">
          <div>
            <h1>
              Launch what
              <br />
              comes next.
            </h1>
          </div>
          <div className="hero-aside">
            <p>
              A considered launchpad for projects built to endure—uniting
              founders and early participants through transparent, deliberate
              launches.
            </p>
            <a className="button" href="#launch">
              Enter the launchpad <Arrow />
            </a>
          </div>
        </div>
        <div className="allocation-strip" aria-label="Latest allocation">
          <span className="allocation-status">● Now allocating</span>
          <span className="allocation-code">THRU — GENESIS 001</span>
          <span className="allocation-value">8,492,750.00 USDC</span>
        </div>
      </section>

      <section className="stats section-shell" aria-label="Platform statistics">
        {stats.map(([value, label]) => (
          <div className="stat" key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </section>

      <section className="process section-shell" id="process">
        <div className="section-intro">
          <p className="section-kicker">I — The Process</p>
          <h2>A more deliberate path from idea to allocation.</h2>
          <p className="section-summary">
            Three measured stages. One continuous record. Everything necessary,
            nothing extraneous.
          </p>
        </div>
        <div className="steps">
          {steps.map((step) => (
            <article className="step" key={step.number}>
              <div className="step-number">{step.number}</div>
              <div>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="manifesto section-shell" aria-label="Manifesto">
        <p className="section-kicker">An article of belief</p>
        <blockquote>
          “The strongest projects do not ask for attention. They earn
          conviction.”
        </blockquote>
        <div className="manifesto-meta">
          <span>@thru, founding principle</span>
          <span>01 / 03</span>
        </div>
      </section>

      <section className="principles section-shell" id="principles">
        <div className="principles-heading">
          <p className="section-kicker">II — The Principles</p>
          <h2>Designed for substance.</h2>
        </div>
        <div className="principle-list">
          {principles.map((principle, index) => (
            <article className="principle" key={principle.label}>
              <div className="principle-index">0{index + 1}</div>
              <div className="principle-copy">
                <p className="section-kicker">{principle.label}</p>
                <h3>{principle.title}</h3>
                <p>{principle.text}</p>
                <span>{principle.note}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="final-cta" id="launch">
        <div className="final-cta-inner section-shell">
          <p className="section-kicker">The next record begins here</p>
          <h2>Make it consequential.</h2>
          <p>
            Bring your project to a launchpad built for clear thinking,
            meaningful participation, and lasting momentum.
          </p>
          <a className="button button-light" href="#top">
            Launch with @thru <Arrow />
          </a>
        </div>
      </section>

      <footer className="footer section-shell">
        <a className="brand" href="#top">
          <span>@</span>thru
        </a>
        <p>Launch infrastructure for what comes next.</p>
        <div>
          <a href="#top">X / Twitter</a>
          <a href="#top">Documentation</a>
          <a href="#top">Terms</a>
        </div>
        <span>© 2026 @thru</span>
      </footer>
    </main>
  );
}
