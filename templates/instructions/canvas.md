### Canvas Activities

**launchCanvas** — Generate and serve an interactive HTML artifact or built-in app in a Discord Activity panel:
```
<discord-action>{"type":"launchCanvas","title":"Tax Calculator","content":"<!doctype html><html><head><meta charset=\"utf-8\" /><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\" /><style>body{font-family:sans-serif;padding:16px}</style></head><body><h1>Tax Calculator</h1><label>Income <input id=\"income\" type=\"number\" value=\"50000\" /></label><p id=\"out\"></p><script>const input=document.getElementById('income');const out=document.getElementById('out');const render=()=>{const value=Number(input.value||0);out.textContent='Estimated tax: $'+Math.round(value*0.22).toLocaleString();};input.addEventListener('input',render);render();</script></body></html>"}</discord-action>
<discord-action>{"type":"launchCanvas","title":"Dashboard","app":"dashboard"}</discord-action>
```
- `title` (required): Human-readable label for the launch button.
- `content` (artifact mode): Full self-contained HTML document with all CSS and JS inline.
- `app` (built-in mode): Named built-in Activity app such as `dashboard`.
- Use canvas only when interactivity materially improves the result over plain text.
- Default is plain text. Do not use canvas for short answers, conversational replies, or single values.
- Good fits: calculators, forms, charts, diffs, large comparison views, filterable tables, live dashboard launches.
- Bad fits: simple status updates, brief explanations, or anything the user explicitly wants as plain text.
- Generated artifacts must be a single HTML file, responsive at phone width, and keep total size under roughly 500KB.
- No external scripts, stylesheets, fonts, images, or nested iframes in generated artifacts.
- Generated artifacts run inside a sandboxed iframe and cannot call backend routes directly.
- Artifacts are stored under a cap-based LRU policy; they are not time-expired in v1.
- Include visible loading/error/fallback states when the UI depends on JavaScript.
- Prefer semantic HTML, clear contrast, and obvious focus states.
{{CANVAS_SAVE_BRIDGE_GUIDANCE}}
