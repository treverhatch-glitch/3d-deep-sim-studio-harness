# War Room (React Flow Dashboard)

The richer visual HUB. Fully customizable.

## Easy launch (one time)

```bash
cd hub
npm install
npm run build
cd ..
node hub/server.js
```

Then open http://localhost:3847

## Even easier (dev mode)

```bash
# Terminal 1
node hub/server.js

# Terminal 2
cd hub
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173).

## Customize your own War Room

Edit these files:

- `hub/WarRoom.tsx` — change layout, colors, what nodes show, add new panels
- `hub/index.html` — change the loading screen or add extra HTML

After editing, run `npm run build` again (or just use `npm run dev` while editing).

The simple HTML fallback still works if you never build. The War Room is optional but recommended.

## For non-coders

You only need the commands above. You do not have to understand React.  
If you want visual changes later, ask an agent to edit `hub/WarRoom.tsx` for you.
