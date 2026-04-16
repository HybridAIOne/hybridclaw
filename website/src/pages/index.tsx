import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header
      style={{
        padding: '4rem 0',
        textAlign: 'center',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div className="container">
        <h1 className="hero__title">{siteConfig.title}</h1>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
          <Link
            className="button button--primary button--lg"
            to="/docs/getting-started/installation"
          >
            Get Started
          </Link>
          <Link
            className="button button--secondary button--lg"
            to="/docs/channels/overview"
          >
            Channels
          </Link>
        </div>
      </div>
    </header>
  );
}

export default function Home(): React.JSX.Element {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout title={siteConfig.title} description={siteConfig.tagline}>
      <HomepageHeader />
      <main>
        <section style={{ padding: '2rem 0' }}>
          <div className="container">
            <div className="row">
              <div className="col col--4">
                <h3>Multi-Channel</h3>
                <p>
                  Connect to Discord, Slack, Teams, iMessage, WhatsApp,
                  Telegram, Email, and more from a single runtime.
                </p>
              </div>
              <div className="col col--4">
                <h3>Extensible</h3>
                <p>
                  Build custom skills, plugins, and memory integrations.
                  Full plugin SDK with adaptive skill support.
                </p>
              </div>
              <div className="col col--4">
                <h3>Enterprise Ready</h3>
                <p>
                  Sandboxed execution, secure credential storage, approval
                  workflows, and comprehensive audit logging.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
