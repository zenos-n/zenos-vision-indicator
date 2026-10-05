import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BACKEND = 'http://localhost:7799/detect';
const BOX_COLOR = { r: 232, g: 255, b: 0, a: 200 };   // #e8ff00
const LABEL_BG  = 'rgba(0,0,0,0.75)';

// ── overlay layer ────────────────────────────────────────────────────────────

const BBoxOverlay = GObject.registerClass(
class BBoxOverlay extends St.Widget {
    _init() {
        super._init({
            name: 'zen-vision-overlay',
            reactive: false,
            x: 0, y: 0,
        });
        this._boxes = [];
    }

    setBoxes(boxes, scaleX, scaleY) {
        this._boxes.forEach(b => b.destroy());
        this._boxes = [];

        for (const { label, bbox } of boxes) {
            const [x1, y1, x2, y2] = bbox;
            const x = x1 * scaleX, y = y1 * scaleY;
            const w = (x2 - x1) * scaleX, h = (y2 - y1) * scaleY;

            // border rect
            const rect = new St.Widget({
                style: `border: 2px solid rgba(232,255,0,0.9);`,
                x, y, width: w, height: h,
                reactive: false,
            });
            this.add_child(rect);
            this._boxes.push(rect);

            // label
            const lbl = new St.Label({
                text: label,
                style: `background: ${LABEL_BG}; color: #e8ff00;
                        font-family: "IBM Plex Mono", monospace;
                        font-size: 10px; padding: 1px 4px;`,
                x: x + 2,
                y: Math.max(0, y - 18),
                reactive: false,
            });
            this.add_child(lbl);
            this._boxes.push(lbl);
        }
    }

    clear() {
        this._boxes.forEach(b => b.destroy());
        this._boxes = [];
    }
});

// ── panel button ─────────────────────────────────────────────────────────────

export default class ZenVision extends Extension {
    enable() {
        this._overlay = new BBoxOverlay();
        Main.layoutManager.addTopChrome(this._overlay);

        this._button = new St.Button({
            style_class: 'panel-button',
            reactive: true, can_focus: true, track_hover: true,
        });
        this._label = new St.Label({
            text: '⊹ vision',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-family: "IBM Plex Mono", monospace; font-size: 11px;',
        });
        this._button.set_child(this._label);
        this._button.connect('clicked', () => this._onButtonClicked());

        this._entry = new St.Entry({
            hint_text: 'find...',
            style: 'width: 160px; font-family: "IBM Plex Mono", monospace; font-size: 11px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._box = new St.BoxLayout({ style_class: 'panel-button', reactive: true });
        this._box.add_child(this._entry);
        this._box.add_child(this._button);

        Main.panel._rightBox.insert_child_at_index(this._box, 0);

        // click anywhere to clear
        this._clearId = global.stage.connect('button-press-event', () => {
            this._overlay.clear();
        });
    }

    disable() {
        if (this._clearId) global.stage.disconnect(this._clearId);
        this._box?.destroy();
        this._overlay?.destroy();
        this._box = this._overlay = null;
    }

    async _onButtonClicked() {
        const prompt = this._entry.get_text().trim() || 'clickable element';
        this._label.set_text('…');

        try {
            const b64 = await this._screenshot();
            const monitor = global.display.get_primary_monitor();
            const geom = global.display.get_monitor_geometry(monitor);

            const resp = await this._post(BACKEND, { image: b64, prompt });
            const data = JSON.parse(resp);
        const W = global.screen_width;
        const H = global.screen_height;
        const boxes = data.boxes.map(b => ({
            label: b.label,
            bbox: [b.x * W, b.y * H, (b.x + b.w) * W, (b.y + b.h) * H]
        }));

            // screenshot is native res; overlay is CSS px — compute scale
            const scaleX = geom.width  / global.screen_width  || 1;
            const scaleY = geom.height / global.screen_height || 1;

            this._overlay.set_size(geom.width, geom.height);
            this._overlay.set_position(geom.x, geom.y);
            this._overlay.setBoxes(boxes, scaleX, scaleY);
        } catch(e) {
            log(`zen-vision error: ${e}`);
        } finally {
            this._label.set_text('⊹ vision');
        }
    }
  
	_screenshot() {

    return new Promise((resolve, reject) => {

        const path = `/tmp/zen-vision-${Date.now()}.png`;

        const proc = new Gio.Subprocess({

            argv: ['/home/doromiert/Downloads/zen-vision/.venv/bin/python3', '-c', `import pyscreenshot as I; I.grab().save('${path}')`],

            flags: Gio.SubprocessFlags.NONE,

        });

        proc.init(null);

        proc.wait_async(null, (p, res) => {

            try {

                p.wait_finish(res);

                const file = Gio.File.new_for_path(path);

                const [, data] = file.load_contents(null);

                const b64 = GLib.base64_encode(data);

                file.delete(null);

                resolve(b64);

            } catch(e) { reject(e); }

        });

    });

}

_post(url, body) {
    return new Promise((resolve, reject) => {
        const jsonPath = `/tmp/zen-vision-req-${Date.now()}.json`;
        const file = Gio.File.new_for_path(jsonPath);
        file.replace_contents(
            new TextEncoder().encode(JSON.stringify(body)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
        );

        const proc = new Gio.Subprocess({
            argv: [
                'curl', '-sf', '-X', 'POST',
                '-H', 'Content-Type: application/json',
                '-d', `@${jsonPath}`,
                url
            ],
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
        });
        proc.init(null);
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                file.delete(null);
                resolve(stdout);
            } catch(e) { reject(e); }
        });
    });
}
}
