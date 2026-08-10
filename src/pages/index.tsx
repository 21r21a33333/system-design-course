import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';

export default function Home(): React.JSX.Element {
  return (
    <Layout title="System Design Course" description="A progress-tracked system-design-primer course">
      <main className="container margin-vert--lg">
        <h1>System Design Course</h1>
        <p>
          A progress-trackable replica of{' '}
          <a href="https://github.com/donnemartin/system-design-primer">donnemartin/system-design-primer</a>{' '}
          (CC BY 4.0), with flashcards and a completion dashboard.
        </p>
        <p>
          <Link className="button button--primary" to="/docs/concepts/study-guide">
            Start the course
          </Link>{' '}
          <Link className="button button--secondary" to="/progress">
            My Progress
          </Link>
        </p>
      </main>
    </Layout>
  );
}
