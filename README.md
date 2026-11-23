# Keystone Logo Engraving Proof

Customers upload a logo. The page finds the logo in the file (trimming empty space,
stray marks and border lines), checks it against Keystone's artwork specs
(1200 DPI preferred, 600 DPI minimum at actual size), lets them size it on a 3" drawer
side with a burn preview, and has them sign. A Cloudflare Turnstile check must pass.
The signed proof PDF and their original file then go to Keystone by email through Zapier
(Gmail), sent from Keystone's own Google Workspace account.

```
wrangler.jsonc        Worker config (R2 bucket, Turnstile site key)
src/worker.js         /api/config, /api/send (Turnstile -> R2 -> Zapier), /files/... for the Zap
public/index.html     The customer page. Checks, preview and PDF all run in the browser.
                      The Keystone logo and the proof's drawer diagram are built in.
```

## Setup (all in web dashboards)

### 1. GitHub
New **private** repo `keystone-logo-proof`. "Uploading an existing file" -> drag in
`README.md`, `wrangler.jsonc`, and the `public` and `src` folders (as folders) -> Commit.

### 2. R2 bucket (temporary attachments)
Cloudflare -> **R2 Object Storage -> Create bucket** -> name `keystone-logo-proof-files`.
Then the bucket's **Settings -> Object lifecycle rules -> Add rule**: delete objects
**3 days** after upload, for the whole bucket. Files only live there until Zapier attaches them.

### 3. Worker
**Workers & Pages -> Create -> Import a repository** -> pick the repo. The project name must be
exactly `keystone-logo-proof`. Build command empty, deploy command `npx wrangler deploy` -> Deploy.
Note the `https://keystone-logo-proof.<you>.workers.dev` address.

### 4. Turnstile (bot check)
**Turnstile -> Add widget**: hostname = the workers.dev host (no https://), mode **Managed**.
Paste the **site key** into `wrangler.jsonc` (`TURNSTILE_SITE_KEY`) in GitHub and commit.
Worker -> **Settings -> Variables and Secrets -> Add**: `TURNSTILE_SECRET_KEY`, type **Secret**.

### 5. Zapier (the email)
1. New Zap. Trigger: **Webhooks by Zapier -> Catch Hook**. Copy the webhook URL.
   (Webhooks by Zapier needs a paid Zapier plan.)
2. Worker -> Settings -> Variables and Secrets -> Add `ZAPIER_HOOK_URL`, type **Secret**, paste it.
3. On the page, send one real test proof. In Zapier, **Test trigger** to pull in the sample.
4. Action: **Gmail -> Send Email** (connect Keystone's Google account):
   - To: `info@keystonewood.com` (or whoever)
   - Subject: `subject`
   - Body Type: **HTML**, Body: `html`
   - Attachments: `proofUrl` and `logoUrl` (Gmail fetches the files from those links)
5. Test the action, check the inbox, then **Publish** the Zap.

Other fields you can map: customerNumber, company, contact, size, dpi, verdict, lowRes
(yes/no), notes, fileName, signed, receivedAt, text (plain-text body). Low-resolution sends
have "(BELOW 600 DPI)" in the subject.

### 6. Link it
Link to the workers.dev address from keystonewood.com/laser-engraving. (A nicer address
like logoproof.keystonewood.com needs keystonewood.com's DNS in Cloudflare; if you move it
later, add the hostname to the Turnstile widget too.)

If a send fails, the page shows why ("security check isn't set up", "Zapier webhook isn't
set up", "couldn't be passed to Keystone"). Details are in the Worker's **Logs** tab.

## What customers see

1. **Add a file** - a thumbnail shows the dashed box we measured and shades what we
   left out. "Include everything in my file" puts stray marks / border lines back.
2. **Size it on a drawer side** - the logo burned onto a maple side at the default
   position (3" from the front, 1/2" down), at about actual size when the window is wide
   enough, on a 3" drawer side. The slider snaps to 1/4", stops at the tallest logo that
   clears the bottom groove on a 3" side (1-11/16"; `CONFIG.drawerHeightIn`), and its track is
   colored green (1200+ DPI), amber (600-1199) and red (below 600) for their file.
   The logo is shown **burned into hard maple**, not pasted on. Switch between
   *Whole side* and *Close-up* (up to 4x) to see edge char, grain and fine detail.
   Dovetails are 3/8" long and flared on a 1" pitch (sizes from the proof template),
   offset so the bottom groove sits centered between two tails and never cuts through
   one. Set `CONFIG.dovetail.anchor` to "top" for the template's original spacing.
3. **Quality check** - updates live as they slide.
4. **Sign and send** - company, Keystone customer number and name are required. They
   draw a signature, then *Approve and send* emails Keystone. The customer number accepts
   digits only (letters and symbols are stripped as they type or paste). Below 600 DPI they get a
   warning but can still send ("Approve and send anyway"); the email subject then says
   "(BELOW 600 DPI)" with a red note at the top. Customers
   never see the proof sheet; it's built in the background and only goes to Keystone.

## Phones and tablets

Below 960px wide the page becomes one column in working order: add the file, size it on
the drawer side, quality check, then sign and send. Phones open the burn preview in
Close-up, controls are at least 44px tall for fingers, and the signature survives
rotating the phone.

## Burn simulation

The preview uses the same tone pipeline as Keystone's Bubble engraving preview:
luminance -> black/white points -> gamma -> darkness -> white floor -> dark clip
(-> optional 4x4 dither). The result is laid on procedural maple like a multiply blend,
with a slight beam-spot softening on the edges.

With the default numbers (gamma 1.55, black 30, white 225, white floor 175, dark clip 0.75,
darkness 0.55) it's close to a hard cutoff: anything with luminance 146 or darker burns
solid, lighter tones only get a faint tint, because the laser doesn't hold gradients.
One difference from Bubble: the white background isn't tinted (`skipWhite`), since the
laser doesn't engrave white.

**Adjust it:** open the page with `?tune` on the end of the URL. A tuning panel shows the
same tokens (bbGamma, bbBlack, bbWhite, bbWhiteFloor, bbDarkClip, bbDarkness, bbDither)
plus beam spot and dither spacing. *Compare with a photo* shows a photo of a real engraving
under the panel. Click *Copy settings for CONFIG* and paste over `burn:` in `CONFIG`.
The color of a solid burn is `CONFIG.woods.maple.burnDeep`. Customers never see the panel.

The emailed PDF proof stays black on white, like the original template.

## Settings

Top of the script in `public/index.html`, `CONFIG`:

| Setting | Default | Meaning |
|---|---|---|
| minDpi / idealDpi | 600 / 1200 | From keystonewood.com/laser-engraving |
| maxWidthIn / maxHeightIn | 6 / 1.75 | **Placeholder** slider limits - set Keystone's real max |
| minWidthIn / sizeStepIn | 0.5 / 0.25 | Slider start and snap step (0.125 for 1/8") |
| drawerHeightIn | 3 | Drawer side height for the preview; also caps logo height to clear the groove |
| grooveFromBottomIn / grooveIn | 0.5 / 0.25 | Bottom groove the logo must clear |
| padding.groupGap | 0.35 | How close marks must be to count as one group |
| padding.keepGroupFrac | 0.15 | Separate groups at least this big are kept (logo mark + wordmark) |
| padding.excessiveFrac | 0.5 | Mention trimming when more than half the file is empty |
| thinFeatureIn | 0.008 | Lines thinner than this get a note |
| softEdgePx / enlargedEdgePx | 3.2 / 6 | Edge blur thresholds for "enlarged web image" detection |
| maxUploadMB | 15 | Keeps the email under Cloudflare's 25 MB limit |
