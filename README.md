# BrannEco Website

A product catalogue website with an administrator dashboard, powered by HTML, CSS, vanilla JavaScript, Express, and SQLite.

## Project layout

```text
index.html                 Homepage and category navigation
pages/                     Product, cart, and custom mould pages
assets/css/style.css       Shared site styles
assets/js/cart.js          Cart and currency behavior
assets/js/product-catalog.js Product quick-add behavior
admin.html                  Administrator dashboard (password protected)
server.mjs                  Store API, administrator sessions, and SQLite storage
data/                       Private order, query, catalogue, and session database
uploads/                    Product images uploaded from the dashboard
images/<page-name>/        Images used by each HTML page
BrannEco_Catalogue.pdf     Downloadable product catalogue
```

Each page keeps its own image files in a flat folder under `images/`. The homepage stays at the project root so it can be opened directly.

## First-time setup

Install Node.js 20 or newer. In this project folder, install dependencies and create the administrator account:

```powershell
npm install
npm run admin:create
npm start
```

The account setup asks for an administrator email address and a new 12-character-or-longer **site password** (typed without displaying it). It stores a bcrypt password hash in your private `.env` file; it never asks for or stores your email account password. Restart the server after creating the administrator account.

Open [http://localhost:3000](http://localhost:3000) for the storefront or [http://localhost:3000/admin.html](http://localhost:3000/admin.html) for the dashboard. The dashboard requires the server to be running; opening its HTML file directly will not enable authentication or database features.

## Admin features

- Update each listed product's INR and export prices. Numeric prices, ranges, and quote text are supported.
- Upload a JPG, PNG, or WebP product image up to 5 MB. Selecting a product variant shows its image.
- Review storefront quote requests; product details and prices are saved as an order snapshot, and order statuses can be updated.
- Read customer enquiries and email replies from the dashboard once outgoing SMTP is configured.

Product changes are stored in SQLite and automatically applied to the product tables/dropdowns when customers visit the running storefront. Enquiry messages submitted using the storefront contact button and orders submitted using the cart checkout are persisted locally. Existing direct `mailto:` links continue to depend on the visitor's email app and are **not** captured by the enquiry inbox.

## Email replies

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and optionally `MAIL_FROM` in the ignored local `.env` file. The SMTP account should be a business/service mailbox; do not use a Google account password. For Gmail SMTP, configure Google's supported app-password sign-in and protect that app password as a secret. SMTP settings are required only to deliver customer emails.

## Local development and deployment

The SQLite database and image uploads live under `data/` and `uploads/`; both are ignored by Git and backed by this local server. Back them up securely. For a public production deployment, use HTTPS, durable private database/image storage, strong private SMTP credentials, and a hardened Node host. This single-server SQLite setup is intended for local/small-store use; it is not a multi-instance hosted commerce platform.
