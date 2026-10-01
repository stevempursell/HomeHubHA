# Home Hub non-admin panel

Add the following to Home Assistant's `configuration.yaml` and restart Home Assistant:

```yaml
panel_custom:
  - name: home-hub
    url_path: home-hub
    js_url: /api/hassio/app/entrypoint.js
    embed_iframe: true
    require_admin: false
    config:
      ingress: local_home_hub
```

This intentionally omits `sidebar_title`, so Home Hub does not add another sidebar item. It remains available at:

```text
/home-hub
```

A dashboard button can navigate to it with:

```yaml
type: button
name: Home Hub
icon: mdi:home-floor-plan
tap_action:
  action: navigate
  navigation_path: /home-hub
```

If `configuration.yaml` already has a `panel_custom:` section, add only the list item beneath the existing section instead of adding a second `panel_custom:` key.
