/**
 * About (#/about): the public face — what tracelog is, where the code
 * lives, how to set it up. The only data view that renders without a
 * profile: the root URL lands here for new visitors (app.ts routing).
 */
import { el } from '../dom';
import { setView } from '../hashstate';

const REPOS = [
  ['tracelog', 'the agent — a fork of the Elastic APM Node.js agent that writes gzipped JSONL to S3 instead of an APM server'],
  ['tracelog-client', 'a tiny client for relaying mobile/browser events and perf timers through your server'],
  ['tracelog-viewer', 'this app — an entirely in-browser APM and log explorer'],
];

const CORS_SNIPPET = `{
  "CORSRules": [{
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["https://*.tracelog.org", "http://localhost:5173"],
    "ExposeHeaders": ["ETag", "Content-Length", "Last-Modified"],
    "MaxAgeSeconds": 3600
  }]
}`;

export function renderAbout(container: HTMLElement): () => void {
  const wrap = el('div', { className: 'about' });

  const intro = el('div', { className: 'about-panel' }, [
    el('h2', { text: 'Observability, essentially free' }),
    el('p', {
      text:
        'Tracelog is an on-ramp: Elastic-quality auto-instrumentation for a young ' +
        'service, with S3-grade operational complexity. The agent — a fork of the ' +
        'open-source Elastic APM Node.js agent — captures transactions, spans, ' +
        'errors, metrics, and custom events, and writes them as gzipped JSONL ' +
        'files to an S3 bucket you own. No cluster, no ingest pipeline, no per-GB ' +
        'pricing. This site is the other half: a viewer that lists, fetches, ' +
        'decompresses, parses, and charts those files entirely in your browser.',
    }),
    el('p', {
      text:
        'Your credentials stay in this tab and are sent only to AWS as request ' +
        'signatures. There is no backend anywhere: the page is static files, your ' +
        'logs live in your bucket, and the browser is the query engine — ' +
        'comfortably to a million records on an ordinary laptop. When a service ' +
        'outgrows that, the records are Elastic-shaped NDJSON: graduating to a ' +
        'real stack later is a feature, not a rewrite.',
    }),
    el('p', {}, [
      el('span', { text: 'Workspaces are free: any subdomain — ' }),
      el('em', { text: 'yourservice' }),
      el('span', {
        text:
          '.tracelog.org — serves this same page with its own isolated profiles ' +
          'and cache, because browsers partition storage by origin. The server ' +
          'knows nothing.',
      }),
    ]),
  ]);

  const repos = el('div', { className: 'about-panel' }, [
    el('h2', { text: 'The code' }),
    el('p', { text: 'Three repositories, all open source:' }),
    el('ul', {},
      REPOS.map(([name, blurb]) =>
        el('li', {}, [
          el('a', {
            text: `redthreadlabs/${name}`,
            attrs: { href: `https://github.com/redthreadlabs/${name}`, target: '_blank', rel: 'noopener' },
          }),
          el('span', { text: ` — ${blurb}` }),
        ]),
      ),
    ),
  ]);

  const setup = el('div', { className: 'about-panel' }, [
    el('h2', { text: 'Setup' }),
    el('ol', {}, [
      el('li', {}, [
        el('span', {
          text:
            'Instrument your Node.js service with the tracelog agent and point it ' +
            'at a logs bucket (configuration in the ',
        }),
        el('a', {
          text: 'tracelog README',
          attrs: { href: 'https://github.com/redthreadlabs/tracelog', target: '_blank', rel: 'noopener' },
        }),
        el('span', { text: '). It begins rotating gzipped JSONL into the bucket on a daily or hourly schedule.' }),
      ]),
      el('li', {}, [
        el('span', {
          text:
            'One-time bucket setup: a CORS rule so this page may read it, and a ' +
            'read-only IAM user (s3:GetObject + s3:ListBucket on that bucket only — ' +
            'never paste an admin key into a web page, even this one):',
        }),
        el('pre', { text: CORS_SNIPPET }),
      ]),
      el('li', {}, [
        el('span', { text: 'Pick a workspace subdomain, ' }),
        el('a', {
          text: 'connect a profile',
          attrs: { href: '#/config' },
          on: {
            click: (ev: Event) => {
              ev.preventDefault();
              setView('/config');
            },
          },
        }),
        el('span', {
          text:
            ' (bucket, region, the read-only key), and pick a time range. ' +
            'Everything else — discovery, fetching, parsing, caching — is automatic.',
        }),
      ]),
    ]),
    el('p', {}, [
      el('span', {
        text:
          'Prefer not to trust a page someone else hosts with read-only keys? ' +
          'Self-host the identical bytes: clone the viewer and run ',
      }),
      el('span', { className: 'mono', text: 'node scripts/deploy-site.mjs' }),
      el('span', {
        text:
          ' — a turnkey deployer that creates or adopts the bucket, CloudFront ' +
          'distribution, and DNS in your own account. Or skip AWS hosting ' +
          'entirely: the built app runs from any static file server.',
      }),
    ]),
  ]);

  wrap.append(intro, repos, setup);
  container.append(wrap);
  return () => {};
}
