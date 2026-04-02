'use strict';

const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const crypto = require('crypto'); // module natif Node.js
const fs = require('fs');

// ─── Logging structuré (timestamp + niveau) ───────────────────────────────────
const log = {
  info:  (msg)       => console.log(JSON.stringify({ level: 'info',  time: new Date().toISOString(), msg })),
  warn:  (msg)       => console.warn(JSON.stringify({ level: 'warn', time: new Date().toISOString(), msg })),
  error: (msg, err)  => console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), msg, stack: err?.stack ?? String(err) })),
};

// ─── Configuration ────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const DOMAIN = process.env.DOMAIN || 'amelie-naturopathe-normandie.fr';
const BASE_URL = `https://${DOMAIN}`;
const IS_PROD = process.env.NODE_ENV === 'production';

if (IS_PROD && !process.env.DOMAIN) {
  log.warn('La variable DOMAIN n\'est pas définie — utilisation du domaine par défaut : ' + DOMAIN);
}

// ─── Application Express ──────────────────────────────────────────────────────
const app = express();

// Fait confiance au premier proxy (Nginx, Heroku, Render, Railway…)
// Indispensable pour que req.secure et req.ip soient corrects derrière un reverse proxy.
app.set('trust proxy', 1);

// Suppression explicite de X-Powered-By (Helmet le fait aussi, double protection)
app.disable('x-powered-by');

// ─── Redirect : www → non-www  &  HTTP → HTTPS ───────────────────────────────
// Les deux cas sont traités en un seul aller-retour :
//   http://www.domain → https://domain  (1 redirect au lieu de 2)
app.use((req, res, next) => {
  const host = req.headers.host || '';

  // www → non-www, restreint au domaine connu pour éviter tout Host header spoofing
  if (host === `www.${DOMAIN}` || host === `www.${DOMAIN}:${PORT}`) {
    return res.redirect(301, `${BASE_URL}${req.originalUrl}`);
  }

  // HTTP → HTTPS via req.secure (lit X-Forwarded-Proto grâce à trust proxy,
  // gère correctement les valeurs multiples "http, https")
  if (IS_PROD && !req.secure) {
    return res.redirect(301, `${BASE_URL}${req.originalUrl}`);
  }

  next();
});

// ─── En-têtes de sécurité (Helmet) ───────────────────────────────────────────
// CSP activé uniquement en production : en développement il bloque le chargement
// du CSS / JS / images sur localhost (HTTP) à cause de upgrade-insecure-requests.
app.use(
  helmet({
    contentSecurityPolicy: IS_PROD
      ? {
          directives: {
            defaultSrc:              ["'self'"],
            scriptSrc:               ["'self'"],
            styleSrc:                ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc:                 ["'self'", 'https://fonts.gstatic.com'],
            imgSrc:                  ["'self'", 'data:', 'https://upload.wikimedia.org'],
            frameSrc:                ['https://calendar.google.com', 'https://maps.google.com', 'https://www.google.com'],
            connectSrc:              ["'self'"],
            objectSrc:               ["'none'"],
            baseUri:                 ["'self'"],
            formAction:              ["'self'"],
            upgradeInsecureRequests: [],
          },
        }
      : false, // Pas de CSP en local — évite tout blocage des ressources HTTP
    // Désactivé pour permettre les iframes Google Calendar / Maps
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

// ─── Permissions-Policy (restreindre les APIs navigateur inutiles) ────────────
app.use((_req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()'
  );
  next();
});

// ─── Content-Language ─────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('Content-Language', 'fr');
  next();
});

// ─── Vary: Accept-Encoding (sur toutes les réponses, pas seulement compressées)
app.use((_req, res, next) => {
  res.setHeader('Vary', 'Accept-Encoding');
  next();
});

// ─── Compression gzip ─────────────────────────────────────────────────────────
app.use(compression({ threshold: 1024 }));

// ─── Headers SEO ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  // X-Robots-Tag : indique aux crawlers d'indexer et suivre les liens
  if (req.path === '/' || req.path === '/index.html') {
    res.setHeader('X-Robots-Tag', 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1');
  }

  // Link headers : preload des ressources critiques (améliore le LCP)
  if (req.path === '/' || req.path === '/index.html') {
    res.setHeader('Link', [
      '</styles.css>; rel=preload; as=style',
      '<https://fonts.googleapis.com>; rel=preconnect',
      '<https://fonts.gstatic.com>; rel=preconnect; crossorigin',
    ].join(', '));
  }

  next();
});

// ─── Injection SEO JSON-LD (côté serveur, sans modifier le HTML source) ──────
// Ajoute des schemas supplémentaires (FAQPage, Service, WebSite, BreadcrumbList)
// juste avant </head> dans la réponse HTML.
const seoSchemas = JSON.stringify([
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": "Amélie Naturessence",
    "url": `${BASE_URL}/`,
    "description": "Cabinet de naturopathie et bien-être en Normandie. Naturopathe certifiée à Bertreville Saint Ouen, près de Dieppe.",
    "inLanguage": "fr-FR",
    "potentialAction": {
      "@type": "SearchAction",
      "target": `${BASE_URL}/?q={search_term_string}`,
      "query-input": "required name=search_term_string"
    }
  },
  {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": "Amélie Naturessence | Naturopathe Normandie & Dieppe",
    "url": `${BASE_URL}/`,
    "description": "Naturopathe à Dieppe et Bertreville Saint Ouen (76). Bilan de vitalité, drainage lymphatique, accompagnement santé naturelle.",
    "inLanguage": "fr-FR",
    "isPartOf": { "@type": "WebSite", "url": `${BASE_URL}/` },
    "about": {
      "@type": "MedicalSpecialty",
      "name": "Naturopathie"
    },
    "speakable": {
      "@type": "SpeakableSpecification",
      "cssSelector": ["#hero .hero-title", "#about .about-text", "#services .section-header"]
    }
  },
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      {
        "@type": "ListItem",
        "position": 1,
        "name": "Accueil",
        "item": `${BASE_URL}/`
      }
    ]
  },
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "Qu'est-ce que la naturopathie ?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "La naturopathie est une approche de santé naturelle et globale qui vise à renforcer les défenses de l'organisme par des moyens naturels : alimentation, phytothérapie, gestion du stress, activité physique. Elle agit en complément de la médecine conventionnelle."
        }
      },
      {
        "@type": "Question",
        "name": "Comment se déroule une séance de naturopathie ?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "La première séance dure environ 1h15. Elle comprend un bilan de vitalité complet (habitudes alimentaires, sommeil, stress, antécédents) suivi de conseils personnalisés en hygiène de vie, alimentation et complémentation naturelle."
        }
      },
      {
        "@type": "Question",
        "name": "Qu'est-ce que le drainage lymphatique ?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Le drainage lymphatique est une technique manuelle douce qui stimule la circulation de la lymphe. Il aide à éliminer les toxines, réduire la rétention d'eau, soulager les jambes lourdes et améliorer l'éclat de la peau. Amélie propose des drainages du visage (Face) et du corps (Body)."
        }
      },
      {
        "@type": "Question",
        "name": "Où se trouve le cabinet d'Amélie Naturessence ?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Le cabinet est situé au 3 route d'Auppegard, 76590 Bertreville Saint Ouen, en Normandie. Il est facilement accessible depuis Dieppe, Offranville, Arques-la-Bataille, Envermeu et les communes environnantes de Seine-Maritime."
        }
      },
      {
        "@type": "Question",
        "name": "Quels sont les tarifs des séances ?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "La séance découverte (bilan personnalisé 1h15) est à 90€. La Cure Vitalité (5 séances de drainage + suivi) est à 400€ soit 80€/séance. Le forfait Transformation (10 séances + bilan initial et final) est à 750€ soit 75€/séance. Des facilités de paiement sont disponibles."
        }
      },
      {
        "@type": "Question",
        "name": "La naturopathie est-elle remboursée ?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "La naturopathie n'est pas remboursée par la Sécurité sociale. En revanche, de nombreuses mutuelles proposent un forfait annuel pour les médecines douces et la naturopathie. Renseignez-vous auprès de votre mutuelle."
        }
      }
    ]
  },
  {
    "@context": "https://schema.org",
    "@type": "Service",
    "serviceType": "Naturopathie et Rééquilibrage Alimentaire",
    "provider": {
      "@type": "HealthAndBeautyBusiness",
      "name": "Amélie Naturessence",
      "url": `${BASE_URL}/`
    },
    "areaServed": {
      "@type": "Place",
      "name": "Normandie, Seine-Maritime (76) — Dieppe, Offranville, Arques-la-Bataille, Envermeu, Bertreville Saint Ouen"
    },
    "description": "Bilan de vitalité complet et programme d'hygiène de vie personnalisé : alimentation, gestion du stress, micro-nutrition, phytothérapie.",
    "offers": {
      "@type": "Offer",
      "price": "90",
      "priceCurrency": "EUR",
      "description": "Séance découverte — Bilan personnalisé (1h15)"
    }
  },
  {
    "@context": "https://schema.org",
    "@type": "Service",
    "serviceType": "Drainage Lymphatique",
    "provider": {
      "@type": "HealthAndBeautyBusiness",
      "name": "Amélie Naturessence",
      "url": `${BASE_URL}/`
    },
    "areaServed": {
      "@type": "Place",
      "name": "Normandie, Seine-Maritime (76) — Dieppe, Offranville, Arques-la-Bataille, Envermeu, Bertreville Saint Ouen"
    },
    "description": "Drainage lymphatique manuel du visage (Face) et du corps (Body). Relance la circulation, élimine les toxines, réduit la rétention d'eau.",
    "offers": [
      {
        "@type": "Offer",
        "price": "400",
        "priceCurrency": "EUR",
        "description": "Cure Vitalité — 5 séances de drainage + suivi personnalisé"
      },
      {
        "@type": "Offer",
        "price": "750",
        "priceCurrency": "EUR",
        "description": "Forfait Transformation — 10 séances + bilan initial et final"
      }
    ]
  }
]);

app.use((req, res, next) => {
  // Uniquement pour la page HTML principale
  if (req.path !== '/' && req.path !== '/index.html') return next();
  if (req.method !== 'GET') return next();

  const filePath = path.join(__dirname, 'public', 'index.html');

  // Lire le fichier, injecter les schemas, et envoyer
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return next(err);

    const injection = `<script type="application/ld+json">${seoSchemas}</script>\n</head>`;
    const enrichedHtml = html.replace('</head>', injection);

    res.type('html').send(enrichedHtml);
  });
});

// ─── Endpoint de santé (pour load balancers, Docker, Kubernetes…) ─────────────
app.get('/healthz', (_req, res) => {
  res.status(200).type('text/plain').end('OK');
});

// ─── Sitemap dynamique ────────────────────────────────────────────────────────
// Mise en cache mémoire : régénéré une seule fois par jour (lastmod change à minuit)
let sitemapCache = null;

function buildSitemap() {
  const today = new Date().toISOString().split('T')[0];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>${BASE_URL}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
    <image:image>
      <image:loc>${BASE_URL}/assets/images/hero_pourville.png</image:loc>
      <image:title>Cabinet Amélie Naturessence - Naturopathe Normandie</image:title>
      <image:caption>Vue du cabinet de naturopathie Amélie Naturessence à Bertreville Saint Ouen, près de Dieppe en Normandie</image:caption>
      <image:geo_location>Bertreville Saint Ouen, Normandie, France</image:geo_location>
    </image:image>
    <image:image>
      <image:loc>${BASE_URL}/assets/images/hero_new.png</image:loc>
      <image:title>Naturopathe Dieppe - Amélie Naturessence Bien-être</image:title>
      <image:caption>Amélie Naturessence, naturopathe certifiée en Seine-Maritime, spécialisée en bilan de vitalité et drainage lymphatique</image:caption>
      <image:geo_location>Dieppe, Normandie, France</image:geo_location>
    </image:image>
    <image:image>
      <image:loc>${BASE_URL}/assets/images/service_naturo.png</image:loc>
      <image:title>Consultation Naturopathie Normandie - Bilan de Vitalité</image:title>
      <image:caption>Séance de naturopathie et bilan de vitalité personnalisé au cabinet de Bertreville Saint Ouen</image:caption>
      <image:geo_location>Bertreville Saint Ouen, Normandie, France</image:geo_location>
    </image:image>
    <image:image>
      <image:loc>${BASE_URL}/assets/images/service_drainage.png</image:loc>
      <image:title>Drainage Lymphatique Dieppe - Bertreville Saint Ouen</image:title>
      <image:caption>Drainage lymphatique manuel du visage et du corps pour éliminer les toxines et relancer la circulation</image:caption>
      <image:geo_location>Bertreville Saint Ouen, Normandie, France</image:geo_location>
    </image:image>
    <image:image>
      <image:loc>${BASE_URL}/assets/images/service_accompagnement.png</image:loc>
      <image:title>Accompagnement Santé Naturelle Normandie</image:title>
      <image:caption>Suivi personnalisé en santé naturelle et prévention par la naturopathie en Seine-Maritime</image:caption>
      <image:geo_location>Bertreville Saint Ouen, Normandie, France</image:geo_location>
    </image:image>
    <image:image>
      <image:loc>${BASE_URL}/assets/images/service_sante.png</image:loc>
      <image:title>Santé et Équilibre Naturel - Naturopathe Seine-Maritime</image:title>
      <image:caption>Retrouvez votre équilibre et votre vitalité grâce à une approche naturelle et bienveillante</image:caption>
      <image:geo_location>Bertreville Saint Ouen, Normandie, France</image:geo_location>
    </image:image>
    <image:image>
      <image:loc>${BASE_URL}/assets/images/service_massage.png</image:loc>
      <image:title>Massage Bien-être Normandie - Cabinet Naturessence</image:title>
      <image:caption>Massage bien-être et relaxation au cabinet Amélie Naturessence à Bertreville Saint Ouen</image:caption>
      <image:geo_location>Bertreville Saint Ouen, Normandie, France</image:geo_location>
    </image:image>
    <image:image>
      <image:loc>${BASE_URL}/assets/images/botanical_divider.png</image:loc>
      <image:title>Branche d'eucalyptus - Décoration naturelle</image:title>
      <image:caption>Élément botanique symbolisant l'approche naturelle du cabinet Amélie Naturessence</image:caption>
    </image:image>
  </url>
</urlset>`;
  const etag = `"${crypto.createHash('sha1').update(xml).digest('hex')}"`;
  return { xml, etag, date: today };
}

app.get('/sitemap.xml', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  // Invalide le cache si le jour a changé
  if (!sitemapCache || sitemapCache.date !== today) {
    sitemapCache = buildSitemap();
  }

  res.set({
    'Content-Type':  'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=86400',
    'ETag':          sitemapCache.etag,
    'Last-Modified': new Date().toUTCString(),
  });

  // Requêtes conditionnelles → 304 Not Modified
  if (req.headers['if-none-match'] === sitemapCache.etag) {
    return res.status(304).end();
  }

  res.send(sitemapCache.xml);
});

// ─── Fichiers statiques ───────────────────────────────────────────────────────
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag:         true,
    lastModified: true,
    maxAge:       '1y', // fallback pour images et autres ressources
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        // HTML : revalidation horaire + stale-while-revalidate pour fluidité
        res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate, stale-while-revalidate=86400');
      } else if (/\/(robots\.txt|sitemap\.xml)$/.test(filePath)) {
        // robots.txt / sitemap statique : renouvellement quotidien
        res.setHeader('Cache-Control', 'public, max-age=86400');
      } else if (/\.(css|js)$/.test(filePath)) {
        // CSS/JS : cache permanent (à invalider via hash dans le nom du fichier)
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
      // Images : maxAge de 1 an (option par défaut ci-dessus)
    },
  })
);

// ─── Page 404 personnalisée ───────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).sendFile(
    path.join(__dirname, 'public', '404.html'),
    (err) => {
      // Fallback si 404.html est illisible (évite une erreur 500 silencieuse)
      if (err) res.type('text/plain').end('404 — Page introuvable');
    }
  );
});

// ─── Gestionnaire d'erreurs global (500) ─────────────────────────────────────
// La signature à 4 arguments est obligatoire pour qu'Express reconnaisse ce middleware
// comme gestionnaire d'erreurs — ne pas la modifier.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  log.error('Erreur non gérée dans un middleware', err);
  if (!res.headersSent) {
    res.status(500).type('text/plain').end('Erreur serveur interne');
  }
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  log.info(`Serveur démarré → http://localhost:${PORT}`);
  log.info(`Environnement : ${process.env.NODE_ENV || 'development'} | Domaine : ${DOMAIN}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`Le port ${PORT} est déjà utilisé`, err);
  } else {
    log.error('Impossible de démarrer le serveur', err);
  }
  process.exitCode = 1;
  process.exit();
});

// ─── Arrêt propre (SIGTERM = orchestrateur / SIGINT = Ctrl+C) ────────────────
function shutdown(signal) {
  log.info(`${signal} reçu — fermeture des connexions en cours…`);
  server.close(() => {
    log.info('Serveur arrêté proprement.');
    process.exit(0);
  });
  // Arrêt forcé après 10 s si des connexions restent ouvertes
  setTimeout(() => {
    log.warn('Timeout dépassé — arrêt forcé.');
    process.exitCode = 1;
    process.exit();
  }, 10_000).unref(); // .unref() évite que ce timer bloque l'arrêt naturel
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── Stabilité du processus ──────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  log.error(
    'Promise rejetée non gérée',
    reason instanceof Error ? reason : new Error(String(reason))
  );
  // Ne pas crasher sur unhandledRejection — logger et continuer
});

process.on('uncaughtException', (err) => {
  // Une exception non interceptée laisse le processus dans un état incertain
  // → on ferme proprement plutôt que de continuer à servir des requêtes
  log.error('Exception non interceptée — arrêt du processus', err);
  process.exitCode = 1;
  server.close(() => process.exit());
});
