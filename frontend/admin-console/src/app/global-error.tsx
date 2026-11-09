'use client';
// Last-resort 500 (AC1.T5): the root layout itself failed, so there are no providers or translations. Static and
// bilingual; the reference is the server's error digest only (GD-12). Plain links on purpose: a full page load is the
// only way back once the root layout failed.
/* eslint-disable @next/next/no-html-link-for-pages */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="fa" dir="rtl">
      <body>
        <main>
          <h1>خطایی رخ داد</h1>
          <p lang="en" dir="ltr">
            Something went wrong.
          </p>
          {error.digest ? (
            <p lang="en" dir="ltr">
              Reference: {error.digest}
            </p>
          ) : null}
          <p>
            <a href="/">کنسول مدیریت</a> ·{' '}
            <a href="/" lang="en" dir="ltr">
              Admin console
            </a>
          </p>
        </main>
      </body>
    </html>
  );
}
