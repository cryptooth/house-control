# House Control

Your home as a live 3D model inside Home Assistant: lights, air conditioners, scenes and charts of every
numeric sensor. It is the web UI of the House Control Mac app, served by a small Node server that talks to
Home Assistant through the Supervisor, so no long-lived access token is needed.

## Using it

- Open **House Control** in the sidebar.
- The settings button at the top right opens **Edit home…** (draw the rooms, place lamps and ACs, link each
  one to an entity) and **Charts…**.
- Until a lamp or an AC is linked to an entity it is simulated. Save the plan with **Save & apply**; it is
  kept in the add-on's data and survives updates.

## On a dashboard

Ingress pages need a session that Home Assistant's add-on panel creates, so a plain Webpage card cannot show
the add-on. `house-control-card.js` (in this folder) does what that panel does:

1. Copy `house-control-card.js` to `/config/www/`.
2. Settings → Dashboards → ⋮ → Resources → Add resource: `/local/house-control-card.js`, type
   *JavaScript module*. Reload the page.
3. Edit a dashboard → Add card → Manual:

   ```yaml
   type: custom:house-control-card
   height: 600px      # optional
   mode: panel        # panel (3D view), charts or editor
   ```

The card needs an administrator account, like the add-on panel itself. For a full-width view, put it in a
view of type *Panel (single card)*.
