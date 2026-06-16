/**
 * About (#/about): the public face — what tracelog is, where the code
 * lives, how to set it up. The only data view that renders without a
 * profile: the root URL lands here for new visitors (app.ts routing).
 */
import { el } from '../dom';
import { setView, getParam, setParams } from '../hashstate';
import { isApexHome, workspaceContext } from '../../data/workspaces';
import { openNewWorkspace } from '../workspaceui';
import heroUrl from '../../assets/overview.jpg';

const REPOS = [
  ['tracelog', 'the agent — a fork of the Elastic APM Node.js agent that writes gzipped JSONL to S3 instead of an APM server'],
  ['tracelog-client', 'a tiny client for relaying mobile/browser events and perf timers through your server'],
  ['tracelog-viewer', 'this app — an entirely in-browser APM and log explorer'],
];

// the examples below adapt to wherever this page is served (the deployment
// apex), so a self-host at tracelog.example.com shows *.tracelog.example.com,
// not the canonical *.tracelog.org
const corsSnippet = (apex: string): string => `{
  "CORSRules": [{
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["https://*.${apex}"],
    "ExposeHeaders": ["ETag", "Content-Length", "Last-Modified", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }]
}`;

/** A scaled-down hero that opens a click-anywhere-to-close lightbox. */
function heroImage(): { figure: HTMLElement; teardown: () => void } {
  const figure = el('figure', { className: 'about-hero' }, [
    el('img', {
      attrs: { src: heroUrl, alt: 'The tracelog viewer’s Overview: a volume chart over a transactions table', loading: 'eager' },
    }),
    el('figcaption', { text: 'The Overview dashboard — tap to enlarge' }),
  ]);

  let lightbox: HTMLElement | null = null;
  const close = (): void => {
    lightbox?.remove();
    lightbox = null;
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') close();
  };
  figure.addEventListener('click', () => {
    if (lightbox) return;
    lightbox = el('div', { className: 'lightbox' }, [
      el('img', { attrs: { src: heroUrl, alt: 'The tracelog viewer’s Overview, enlarged' } }),
    ]);
    lightbox.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.append(lightbox);
  });
  return { figure, teardown: close };
}

export function renderAbout(container: HTMLElement): () => void {
  const wrap = el('div', { className: 'about' });
  const hero = heroImage();

  // the deployment apex this page is served from — drives the CORS + workspace
  // examples below so they're copy-pasteable on a self-host. null on localhost
  // (single-origin dev): fall back to the canonical public apex.
  const apex = workspaceContext().apexHost ?? 'tracelog.org';
  const exampleWorkspace = `yourservice.${apex}`;

  // On the apex you can't configure a profile (it isn't a workspace) — the
  // CTA opens the new-workspace launcher; on a subdomain it opens config.
  const connectCta = (ev: Event): void => {
    ev.preventDefault();
    if (isApexHome()) openNewWorkspace();
    else setView('/config');
  };

  const intro = el('div', { className: 'about-panel' }, [
    el('h1', { text: 'Welcome to Tracelog' }),
    el('div', {
      className: 'about-sub',
      text: 'See what your services are doing, without running a monitoring stack.',
    }),
    hero.figure,
    el('p', {
      text:
        'You shipped a service, and now you want to know what it\u2019s up to: ' +
        'which requests are slow, what broke overnight, what your users actually ' +
        'do. Usually that means signing up for an observability platform \u2014 ' +
        'starting on the free tier, naturally \u2014 and before you know it, ' +
        'you\u2019re spending real money on dashboards.',
    }),
    el('p', {}, [
      el('span', {
        text:
          'Tracelog is the dirt-simple alternative, and the whole system is free ' +
          'and open source. A small tracing client watches your service and ' +
          'appends everything it sees \u2014 requests, database calls, errors, ' +
          'metrics, your own custom events \u2014 to compressed log files ',
      }),
      el('strong', { attrs: { style: 'font-style:italic' }, text: 'in an S3 bucket that you own' }),
      el('span', {
        text:
          '. That\u2019s the entire pipeline. There\u2019s no server to run, ' +
          'nothing to subscribe to, and a month of logs costs pennies to store.',
      }),
    ]),
    el('p', {}, [
      el('span', {
        text:
          'This site is the other half: it reads those files straight from your ' +
          'bucket and turns them into charts, traces, and searchable logs \u2014 ' +
          'entirely in your browser. Your AWS credentials never leave this tab; ' +
          'the page only ever talks to AWS. If your service eventually outgrows ' +
          'this way of working, the log files are the same shape Elastic uses, ' +
          'so moving to a full stack later is an afternoon, not a rewrite. ' +
          'Bucket already set up? ',
      }),
      el('a', {
        text: 'Connect a profile',
        attrs: { href: '#/config' },
        on: { click: connectCta },
      }),
      el('span', { text: ' and start exploring.' }),
    ]),
    el('p', {
      text:
        'And the browser is a more capable query engine than you might think: ' +
        'a working set of more than a million records is comfortable on an ' +
        'ordinary laptop, and up to ten million is still reasonable. Since you ' +
        'only ever load the time range you\u2019re looking at, that\u2019s the ' +
        'only limit that matters. Say you like to observe a week at a time: as ' +
        'long as your services write fewer than ten million records per week, ' +
        'you can keep comprehensive APM dashboards over your entire history \u2014 ' +
        'retention is just S3 storage, which is to say effectively infinite, ' +
        'and effectively free.',
    }),
    el('p', {}, [
      el('span', { text: 'One more trick: any subdomain here \u2014 ' }),
      el('a', {
        text: exampleWorkspace,
        attrs: {
          href: `https://${exampleWorkspace}`,
          target: '_blank',
          rel: 'noopener',
          style: 'font-style:italic;font-weight:700',
        },
      }),
      el('span', {
        text:
          ' \u2014 is its own siloed workspace. Browsers keep ' +
          'storage apart per site, so each subdomain gets a separate set of ' +
          'saved profiles and its own locally-cached data, for free. Use it to ' +
          'keep separate realms for different families of services you watch: ' +
          'bookmark each one, and its configs and cache stay put. It’s just ' +
          'a browser trick, but it’s a good one!',
      }),
    ]),
    el('p', {
      text:
        'There\u2019s no subscription and no upgrades. This isn\u2019t a service ' +
        '\u2014 it\u2019s a static webpage, completely under your own control. ' +
        'And if you\u2019d rather not load it from here at all, you can self-host ' +
        'the very same page on your own infra, also for free.',
    }),
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
        el('pre', { text: corsSnippet(apex) }),
      ]),
      el('li', {}, [
        el('span', { text: 'Pick a workspace subdomain, ' }),
        el('a', {
          text: 'connect a profile',
          attrs: { href: '#/config' },
          on: { click: connectCta },
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

  const credit = el('div', { className: 'about-credit' }, [
    el('span', { text: 'Made by ' }),
    el('a', {
      text: 'Red Thread Labs LLC',
      attrs: { href: 'https://redthre.ad', target: '_blank', rel: 'noopener' },
    }),
    el('span', { text: '.' }),
  ]);

  // confirmation after a workspace purge kicked back here (textContent, not
  // innerHTML — the label comes from the URL)
  const purged = getParam('purged');
  if (purged) {
    const banner = el('div', { className: 'purge-banner' });
    banner.textContent = `Workspace “${purged}” purged — its connection and cached data are gone from this browser.`;
    wrap.append(banner);
    setParams({ purged: null }); // so a refresh doesn't re-show it
  }

  wrap.append(intro, repos, setup, credit);
  container.append(wrap);
  return () => hero.teardown();
}
