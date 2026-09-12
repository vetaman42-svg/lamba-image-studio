# Lamba Image Studio

AI image editing server + iPad web interface.

## Files
- `public/index.html` — Lamba Image Studio interface.
- `server.js` — secure server endpoint for image editing.
- `package.json` — Node.js dependencies.
- `.env.example` — example environment variables.

## Render
Create a **Web Service** from this repository.

Build Command:
`npm install`

Start Command:
`npm start`

Add an environment variable:
`OPENAI_API_KEY` = your OpenAI API key

Do not put the API key into `public/index.html`.

## Important
The browser interface needs the public URL of the deployed Render service. Set it once in the browser console/local storage as documented in the project instructions.
