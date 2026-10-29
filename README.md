# 360 photo tours

Build a walkable tour of any room, building, garden, or other space from 360 photos. Each photo is a place you can stand. From there you look around and step to the next place. The same place can have a day photo and a night photo.

The tour runs in a browser. A VR headset can open it too.

## What to capture

Use any camera that exports a **single equirectangular** image: a 360 camera, or a phone app that stitches a sphere into one picture. The picture should be about twice as wide as it is tall, with the horizon across the middle.

- Stand in one spot and shoot the full sphere. That spot becomes one stop on the tour.
- Leave enough overlap that, from one stop, you can tell where the next stop is.
- Keep the camera at a similar height at every stop. Walking feels steadier that way.
- For day and night, shoot the same spot twice.
- Export the merged panorama, not the separate lens files. JPEG, PNG, and WebP all work.

A floor plan is optional. A sketch, a scan, or a photo of a printed plan is enough. PNG, JPEG, or WebP, up to 30 MB.

## Put the files in place

```text
content/photos/     one panorama per stop
content/plans/      filled in when you upload a floor plan
content/tour.json   written for you when you edit the tour
content/thumbs/     small previews, generated for you
```

Copy the panoramas into `content/photos`. File names can be anything. Then start the server, or refresh the editor if it is already running.

## Run it

Python 3.10 or newer, and [Pillow](https://pypi.org/project/Pillow/) for the previews.

```bash
python3 -m pip install -r requirements.txt
python3 server/serve.py
```

- Tour: http://127.0.0.1:8765
- Editor: http://127.0.0.1:8765/admin

`PORT` changes the port. The process listens on all interfaces and speaks plain HTTP. Put nginx, or another reverse proxy, in front of it when you want HTTPS.

## Pack and deploy

Docker is the only dependency on the machine that will run the tour. The image contains the server, the site, and everything in `content/`, including the panoramas and `tour.json`.

On this machine:

```bash
docker compose up -d --build
```

- Tour: http://127.0.0.1:8765
- Editor: http://127.0.0.1:8765/admin

`HOST_PORT` is the port on the host. The container still listens on 8765.

```bash
HOST_PORT=8080 docker compose up -d --build
```

To move the tour to another machine, pack it, copy the folder, and start it there:

```bash
./scripts/pack.sh
```

That writes `dist/home-tour/` with the image archive, a compose file, and `deploy.sh`. Copy the folder, then on the other machine:

```bash
./deploy.sh
```

Edits you make in the editor are stored in the running container. Copy `tour.json` back out before you replace the container:

```bash
docker compose cp tour:/app/content/tour.json content/tour.json
```

Rebuild after you change photos or that file. The same reverse proxy in front of the container is what a headset needs for HTTPS.

## Build the tour

Open the editor.

1. **Add a floor plan** if you have one. **Fit** frames it. **Expand** adds empty space around it when a stop sits outside the drawing. **Floor plan opacity** fades the plan so the pins stay readable. Skip the plan if you only want a simple grid of stops.
2. **Add pin**, then click the plan where that stop is. Drag a pin to move it. Name it after the room or the spot.
3. Select a photo in the left tray and choose **Set as day** or **Set as night**. A stop can have one photo, or both.
4. Drag the arrow, or use **Direction**, so the place faces the same way the camera was facing on the plan. Day and night share that direction. Under each photo, **Look** turns the picture so the two shots of one place line up. **Step inside**, look toward the next stop, and use **This view points to the top** if you would rather set the plan direction from the photo itself.
5. Under **Jumps from here**, choose which other stops can be walked to from this photo. A jump is one way: the way back is a jump on the other stop.
6. **Step inside** and click a marker. It should sit in the part of the room where that next stop actually is. If it does not, adjust the arrow and the pin, then look again.

Edits save on their own into `content/tour.json`. **Reset layout** puts every photo on its own pin again. **Remove all pins** clears the stops and leaves the photos in the tray.

## Walk through it

Open the site root, not `/admin`. The tour starts at the first stop that has a photo.

- Drag to look around. On a phone, swipe.
- Click or tap a marker to walk to that stop.
- **Day** and **Night** switch the two photos of the current stop.
- **Back to map** returns to the plan.

## Open it in a headset

On the headset, open the HTTPS address served by your reverse proxy, then tap **Enter VR**. Browsers only allow VR on a secure page.

## Project layout

```text
web/                 the editor and the viewer
  index.html
  css/styles.css
  js/app.js
server/serve.py      local server and the save API
content/             the space you are touring
requirements.txt
Dockerfile           self-contained image
docker-compose.yml   run the image
scripts/pack.sh      write a folder you can copy to another machine
```

Application code stays in `web/` and `server/`. Everything that describes one particular space stays in `content/`, so the same app can host a home, a gallery, a campus, or a job site. To start a different space, replace the files in `content/photos`, remove `content/tour.json`, and build the tour again. You can also keep each space in its own copy of the project.
