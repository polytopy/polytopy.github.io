// captcha.js
//
// A point cloud spam gate for the contact form. The characters of a short code
// are sampled into points and staggered in depth, then a simulated focal plane
// sweeps through them, so each character resolves in turn while its neighbours
// scatter into bokeh. The view orbits gently to give the cloud parallax.
//
// The code itself comes from the Apps Script backend, together with a
// single-use nonce; the backend keeps the answer and checks it when the form
// is posted. The browser cannot be the authority here - a static page has
// nowhere to hide a secret - so everything on this side is presentation and
// quick feedback, and backend/code.gs is what actually decides. If the backend
// cannot be reached the widget falls back to a locally generated code, which
// is a courtesy to the sender rather than a check.
(function (window, document) {
    'use strict';

    // --- Tuning ---

    // Glyphs that stay distinguishable as loose points: no O/0, I/1, S/5, B/8,
    // Z/2, G/6, Q/9, U/V.
    const ALPHABET = 'ACDEFHJKLMNPRTVWXY34';
    const CODE_LENGTH = 4;
    const COLOURS = ['#ea4335', '#34a853', '#4285f4', '#fbbc05'];

    const POINTS_PER_GLYPH = 270;   // Points sampled from each character.
    const GLYPH_GAP = 0.38;         // Horizontal gap between glyphs, in cap heights.
    const DEPTH_STEP = 0.70;        // Depth stagger between neighbouring glyphs.
    // A long lens on purpose: the depth stagger is large next to the model, so
    // a close camera magnifies the near glyphs far past the frame and the fit
    // below has to shrink everything to compensate. Defocus does not care how
    // long the lens is, only how far a point sits from the focal plane.
    const CAMERA_DISTANCE = 12.0;   // Camera to model centre.
    const DOT_SIZE = 0.020;         // In-focus point radius, in cap heights.
    const BLUR_STRENGTH = 0.24;     // Circle of confusion per unit of defocus.
    const DWELL_SECONDS = 1.25;     // Time each glyph spends as the focal subject.
    const YAW_AMPLITUDE = 0.20;     // Orbit is deliberately shallow so the depth
    const PITCH_AMPLITUDE = 0.16;   // stagger does not scramble the reading order.
    const DRAG_YAW = 0.26;          // How far a drag may push past the orbit.
    const DRAG_PITCH = 0.14;

    const CHALLENGE_TIMEOUT_MS = 8000;  // Past this the backend is treated as absent.

    const TRAP_NAME = 'Fax';        // Honeypot field; never filled by a person.
    // Kept just above the backend's own minimum so the quick local complaint
    // fires before the round trip does, never after it.
    const MIN_FILL_SECONDS = 3;

    // --- Utilities ---

    function randomInt(limit) {
        const values = new Uint32Array(1);
        if (window.crypto && window.crypto.getRandomValues) {
            window.crypto.getRandomValues(values);
            return values[0] % limit;
        }
        return Math.floor(Math.random() * limit);
    }

    function randomCode(length) {
        let code = '';
        for (let i = 0; i < length; i++) {
            code += ALPHABET[randomInt(ALPHABET.length)];
        }
        return code;
    }

    function hexToRgb(hex) {
        const value = parseInt(hex.slice(1), 16);
        return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
    }

    function smoothstep(t) {
        const x = Math.min(Math.max(t, 0), 1);
        return x * x * (3 - 2 * x);
    }

    function normalise(answer) {
        return String(answer == null ? '' : answer).replace(/\s+/g, '').toUpperCase();
    }

    // --- Point sampling ---

    // Renders a character to an offscreen canvas and keeps a random subset of
    // the inked pixels, normalised so every glyph is one unit tall and centred.
    function sampleGlyph(character) {
        const size = 96;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;

        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#000000';
        ctx.font = `700 ${Math.round(size * 0.70)}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(character, size / 2, size / 2);

        const data = ctx.getImageData(0, 0, size, size).data;
        const inked = [];
        let minX = size, maxX = 0, minY = size, maxY = 0;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (data[(y * size + x) * 4 + 3] > 140) {
                    inked.push(x, y);
                    if (x < minX) { minX = x; }
                    if (x > maxX) { maxX = x; }
                    if (y < minY) { minY = y; }
                    if (y > maxY) { maxY = y; }
                }
            }
        }

        const height = Math.max(maxY - minY, 1);
        const scale = 1 / height;
        const centreX = (minX + maxX) / 2;
        const centreY = (minY + maxY) / 2;

        // Keep a random subset rather than every nth pixel: a regular stride
        // through the scanlines leaves the glyph looking like a halftone screen.
        const total = inked.length / 2;
        const keep = Math.min(POINTS_PER_GLYPH, total);
        const indices = new Int32Array(total);
        for (let i = 0; i < total; i++) {
            indices[i] = i;
        }
        const points = [];
        for (let i = 0; i < keep; i++) {
            const j = i + Math.floor(Math.random() * (total - i));
            const chosen = indices[j];
            indices[j] = indices[i];
            points.push({
                x: (inked[chosen * 2] - centreX) * scale,
                y: -(inked[chosen * 2 + 1] - centreY) * scale,
                z: (Math.random() - 0.5) * 0.07
            });
        }

        return { points: points, width: (maxX - minX) * scale };
    }

    // Lays the glyphs out left to right, staggered in depth, centred on the origin.
    function buildCloud(code) {
        const glyphs = [];
        let cursor = 0;
        for (let i = 0; i < code.length; i++) {
            const glyph = sampleGlyph(code[i]);
            glyph.centreX = cursor + glyph.width / 2;
            glyph.centreZ = (i - (code.length - 1) / 2) * DEPTH_STEP;
            cursor += glyph.width + GLYPH_GAP;
            glyphs.push(glyph);
        }

        const modelWidth = Math.max(cursor - GLYPH_GAP, 0.001);
        const shift = modelWidth / 2;

        const points = [];
        glyphs.forEach(function (glyph, i) {
            glyph.centreX -= shift;
            glyph.points.forEach(function (point) {
                points.push({
                    x: point.x + glyph.centreX,
                    y: point.y,
                    z: point.z + glyph.centreZ,
                    colour: i % COLOURS.length
                });
            });
        });

        return {
            points: points,
            anchors: glyphs.map(function (glyph) {
                return { x: glyph.centreX, z: glyph.centreZ };
            }),
            width: modelWidth
        };
    }

    // --- Rendering ---

    // One soft disc per colour, drawn scaled: a tight dot when in focus, a wide
    // bokeh blob when not. Fades to a transparent version of its own colour so
    // the edges do not fringe.
    function makeSprite(hex) {
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;

        const rgb = hexToRgb(hex);
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        gradient.addColorStop(0.00, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 1)`);
        gradient.addColorStop(0.45, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.92)`);
        gradient.addColorStop(0.80, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.35)`);
        gradient.addColorStop(1.00, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);

        return canvas;
    }

    const SPRITES = COLOURS.map(makeSprite);

    class Stage {
        constructor(canvas) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.cloud = null;
            this.order = [];
            this.projected = [];
            this.yaw = 0;
            this.pitch = 0;
            this.dragYaw = 0;
            this.dragPitch = 0;
            this.elapsed = 0;
            this.still = false;
            this.focalLength = 0;
            this.fitKey = '';
        }

        load(cloud) {
            this.cloud = cloud;
            this.projected = cloud.points.map(function () {
                return { sx: 0, sy: 0, radius: 0, alpha: 0, colour: 0, blur: 0 };
            });
            this.order = cloud.points.map(function (ignored, i) {
                return i;
            });
            this.elapsed = 0;
            this.fitKey = '';
        }

        // Chooses the focal length that keeps the model inside the canvas at
        // every orientation it can reach. Fitting at the model centre is not
        // enough: perspective magnifies the near glyphs past those bounds, and
        // the orbit swings the far ones outwards.
        fit(width, height) {
            const key = `${width}x${height}x${this.cloud.points.length}`;
            if (key === this.fitKey) {
                return this.focalLength;
            }

            const hx = this.cloud.width / 2;
            const hy = 0.52;
            const hz = (this.cloud.anchors.length - 1) / 2 * DEPTH_STEP + 0.05;
            const yaws = [-(YAW_AMPLITUDE + DRAG_YAW), 0, YAW_AMPLITUDE + DRAG_YAW];
            const pitches = [-(PITCH_AMPLITUDE + DRAG_PITCH), 0, PITCH_AMPLITUDE + DRAG_PITCH];

            let focalLength = Infinity;
            for (let cx = -1; cx <= 1; cx += 2) {
                for (let cy = -1; cy <= 1; cy += 2) {
                    for (let cz = -1; cz <= 1; cz += 2) {
                        yaws.forEach(function (yaw) {
                            pitches.forEach(function (pitch) {
                                const x = cx * hx, y = cy * hy, z = cz * hz;
                                const xr = x * Math.cos(yaw) + z * Math.sin(yaw);
                                const zr = -x * Math.sin(yaw) + z * Math.cos(yaw);
                                const yr = y * Math.cos(pitch) - zr * Math.sin(pitch);
                                const zv = y * Math.sin(pitch) + zr * Math.cos(pitch) + CAMERA_DISTANCE;
                                if (zv < 1) {
                                    return;
                                }
                                focalLength = Math.min(
                                    focalLength,
                                    width * 0.50 * zv / Math.max(Math.abs(xr), 1e-3),
                                    height * 0.49 * zv / Math.max(Math.abs(yr), 1e-3)
                                );
                            });
                        });
                    }
                }
            }

            this.fitKey = key;
            this.focalLength = focalLength;
            return focalLength;
        }

        drag(dYaw, dPitch) {
            this.dragYaw = Math.max(-DRAG_YAW, Math.min(DRAG_YAW, this.dragYaw + dYaw));
            this.dragPitch = Math.max(-DRAG_PITCH, Math.min(DRAG_PITCH, this.dragPitch + dPitch));
        }

        // The focal plane rests on each glyph in reading order, easing between them.
        focalDepth(cosYaw, sinYaw, cosPitch, sinPitch) {
            const anchors = this.cloud.anchors;
            const depthOf = (anchor) => {
                const z = -anchor.x * sinYaw + anchor.z * cosYaw;
                return z * cosPitch + CAMERA_DISTANCE;
            };

            if (this.still) {
                return depthOf({ x: 0, z: 0 });
            }

            const step = this.elapsed / DWELL_SECONDS;
            const current = Math.floor(step) % anchors.length;
            const previous = (current + anchors.length - 1) % anchors.length;
            const blend = smoothstep((step % 1) / 0.4);
            return depthOf(anchors[previous]) * (1 - blend) + depthOf(anchors[current]) * blend;
        }

        render(delta) {
            const ctx = this.ctx;
            const width = this.canvas.width;
            const height = this.canvas.height;

            ctx.clearRect(0, 0, width, height);
            if (!this.cloud || width === 0 || height === 0) {
                return;
            }

            this.elapsed += delta;

            const yaw = this.dragYaw + (this.still ? 0 : YAW_AMPLITUDE * Math.sin(this.elapsed * 0.42));
            const pitch = this.dragPitch + (this.still ? 0 : PITCH_AMPLITUDE * Math.sin(this.elapsed * 0.27));
            const cosYaw = Math.cos(yaw), sinYaw = Math.sin(yaw);
            const cosPitch = Math.cos(pitch), sinPitch = Math.sin(pitch);

            const focalLength = this.fit(width, height);

            const focal = this.focalDepth(cosYaw, sinYaw, cosPitch, sinPitch);
            const blur = this.still ? BLUR_STRENGTH * 0.25 : BLUR_STRENGTH;

            const points = this.cloud.points;
            for (let i = 0; i < points.length; i++) {
                const point = points[i];
                const out = this.projected[i];

                const xr = point.x * cosYaw + point.z * sinYaw;
                const zr = -point.x * sinYaw + point.z * cosYaw;
                const yr = point.y * cosPitch - zr * sinPitch;
                const zv = point.y * sinPitch + zr * cosPitch + CAMERA_DISTANCE;

                const scale = focalLength / zv;
                const dot = Math.max(scale * DOT_SIZE, 1.0);
                const coc = Math.abs(zv - focal) * blur * scale;

                out.sx = width / 2 + xr * scale;
                out.sy = height / 2 - yr * scale;
                out.radius = dot + coc;
                out.alpha = Math.max(Math.pow(dot / out.radius, 1.4), 0.035);
                out.colour = point.colour;
                out.blur = coc;
            }

            // Painter's order: the widest bokeh goes down first so the glyph in
            // focus sits cleanly on top of it.
            const projected = this.projected;
            this.order.sort(function (a, b) {
                return projected[b].blur - projected[a].blur;
            });

            for (let i = 0; i < this.order.length; i++) {
                const p = projected[this.order[i]];
                if (p.sx < -p.radius || p.sx > width + p.radius) {
                    continue;
                }
                ctx.globalAlpha = p.alpha;
                ctx.drawImage(SPRITES[p.colour], p.sx - p.radius, p.sy - p.radius, p.radius * 2, p.radius * 2);
            }
            ctx.globalAlpha = 1;
        }
    }

    // --- Accessible alternative ---

    // Must reach the largest sum the operands can make, or that answer has no
    // word form and only the digits are accepted.
    const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
                          'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
                          'seventeen', 'eighteen', 'nineteen', 'twenty'];

    function textChallenge() {
        const templates = [
            function () {
                const a = 2 + randomInt(6);
                const b = 2 + randomInt(5);
                return {
                    prompt: `What is ${NUMBER_WORDS[a]} plus ${NUMBER_WORDS[b]}? Answer in digits or in words.`,
                    answers: [String(a + b), NUMBER_WORDS[a + b]]
                };
            },
            function () {
                const words = ['camera', 'sensor', 'mapping', 'robot', 'vision', 'lidar'];
                const chosen = [];
                while (chosen.length < 3) {
                    const word = words[randomInt(words.length)];
                    if (chosen.indexOf(word) === -1) {
                        chosen.push(word);
                    }
                }
                const index = randomInt(3);
                return {
                    prompt: `Type the ${['first', 'second', 'third'][index]} word of this list: ${chosen.join(', ')}.`,
                    answers: [chosen[index]]
                };
            },
            function () {
                const colours = ['red', 'green', 'blue', 'yellow'];
                const missing = randomInt(colours.length);
                const shown = colours.filter(function (ignored, i) {
                    return i !== missing;
                });
                return {
                    prompt: `Three of our four colours are ${shown.join(', ')}. Type the missing one: red, green, blue or yellow.`,
                    answers: [colours[missing]]
                };
            }
        ];
        return templates[randomInt(templates.length)]();
    }

    // --- Widget ---

    function build(mount) {
        mount.innerHTML = '';
        mount.classList.add('captcha');

        const label = document.createElement('label');
        label.className = 'captcha-label';
        label.setAttribute('for', 'captchaAnswer');
        label.textContent = 'Human check';
        mount.appendChild(label);

        const hint = document.createElement('p');
        hint.className = 'captcha-hint';
        mount.appendChild(hint);

        const stage = document.createElement('div');
        stage.className = 'captcha-stage';
        mount.appendChild(stage);

        const canvas = document.createElement('canvas');
        canvas.className = 'captcha-canvas';
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', 'A code drawn as a cloud of points. Each character comes into focus in turn. If you cannot read it, use the text question instead.');
        stage.appendChild(canvas);

        const row = document.createElement('div');
        row.className = 'captcha-row';
        mount.appendChild(row);

        const input = document.createElement('input');
        input.type = 'text';
        input.id = 'captchaAnswer';
        input.className = 'captcha-input';
        input.autocomplete = 'off';
        input.autocapitalize = 'characters';
        input.spellcheck = false;
        input.required = true;
        row.appendChild(input);

        const refresh = document.createElement('button');
        refresh.type = 'button';
        refresh.className = 'captcha-action';
        refresh.textContent = 'New code';
        row.appendChild(refresh);

        const swap = document.createElement('button');
        swap.type = 'button';
        swap.className = 'captcha-action';
        row.appendChild(swap);

        const error = document.createElement('p');
        error.className = 'captcha-error';
        error.setAttribute('role', 'alert');
        mount.appendChild(error);

        return {
            hint: hint, stage: stage, canvas: canvas,
            input: input, refresh: refresh, swap: swap, error: error
        };
    }

    function attach(mountSelector, options) {
        const settings = options || {};
        const mount = typeof mountSelector === 'string'
            ? document.querySelector(mountSelector)
            : mountSelector;
        if (!mount) {
            return null;
        }

        const form = mount.closest('form');
        const parts = build(mount);
        const abort = new AbortController();
        const listen = { signal: abort.signal };

        // Honeypot: off-screen, unfocusable and hidden from assistive tech, so
        // anything that fills it in is filling in fields it cannot see.
        let trap = null;
        if (form) {
            trap = document.createElement('input');
            trap.type = 'text';
            trap.name = TRAP_NAME;
            trap.className = 'captcha-trap';
            trap.tabIndex = -1;
            trap.autocomplete = 'off';
            trap.setAttribute('aria-hidden', 'true');
            form.appendChild(trap);
        }

        const stillMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
        const stage = new Stage(parts.canvas);
        stage.still = stillMedia.matches;

        const endpoint = settings.endpoint || (form ? form.getAttribute('action') : '');

        let mode = 'cloud';
        let code = '';
        let question = null;
        let remote = null;          // The challenge the backend issued, if it answered.
        let asked = false;          // Whether the first request has gone out.
        let started = Date.now();
        let interacted = false;
        let frame = 0;
        let last = 0;
        let onScreen = true;

        function sizeCanvas() {
            const ratio = window.devicePixelRatio || 1;
            parts.canvas.width = Math.round(parts.canvas.clientWidth * ratio);
            parts.canvas.height = Math.round(parts.canvas.clientHeight * ratio);
        }

        function running() {
            return mode === 'cloud' && stage.cloud !== null && onScreen && !document.hidden;
        }

        function tick(now) {
            frame = 0;
            if (!running()) {
                return;
            }
            const delta = last ? Math.min((now - last) / 1000, 0.1) : 0;
            last = now;
            stage.render(delta);
            if (!stage.still) {
                frame = window.requestAnimationFrame(tick);
            }
        }

        function start() {
            if (!frame && running()) {
                last = 0;
                frame = window.requestAnimationFrame(tick);
            }
        }

        function stop() {
            if (frame) {
                window.cancelAnimationFrame(frame);
                frame = 0;
            }
        }

        // Asks the backend for a nonce and the challenge that goes with it. A
        // failure here is not fatal: it means an older backend, or none
        // reachable, and the widget carries on with a local code.
        function requestChallenge(wanted) {
            if (!endpoint || !window.fetch) {
                return Promise.resolve(null);
            }
            const url = endpoint + (endpoint.indexOf('?') === -1 ? '?' : '&') +
                'challenge=1&mode=' + encodeURIComponent(wanted);
            // A request that never settles would leave the input disabled for
            // good, so it gets a deadline of its own.
            const deadline = new AbortController();
            const timer = window.setTimeout(function () {
                deadline.abort();
            }, CHALLENGE_TIMEOUT_MS);

            return window.fetch(url, { method: 'GET', signal: deadline.signal })
                .then(function (response) {
                    return response.json();
                })
                .then(function (json) {
                    return (json && json.result === 'challenge' && json.nonce) ? json : null;
                })
                .catch(function () {
                    return null;
                })
                .then(function (challenge) {
                    window.clearTimeout(timer);
                    return challenge;
                });
        }

        function waiting() {
            stop();
            stage.cloud = null;
            parts.hint.textContent = 'Preparing the human check...';
            parts.input.disabled = true;
            parts.input.value = '';
            const ctx = parts.canvas.getContext('2d');
            ctx.clearRect(0, 0, parts.canvas.width, parts.canvas.height);
        }

        // preventScroll matters: the page has usually just been moved to the
        // form status by then, and a plain focus would drag it straight back.
        function focusInput() {
            parts.input.focus({ preventScroll: true });
        }

        function renew(message, focusAfter) {
            if (!endpoint) {
                issue(message);
                if (focusAfter) {
                    focusInput();
                }
                return;
            }
            waiting();
            requestChallenge(mode).then(function (challenge) {
                remote = challenge;
                issue(message);
                if (focusAfter) {
                    focusInput();
                }
            });
        }

        function issue(message) {
            parts.input.value = '';
            parts.input.disabled = false;
            started = Date.now();

            if (mode === 'cloud') {
                code = remote && remote.code
                    ? String(remote.code).toUpperCase()
                    : randomCode(CODE_LENGTH);
                question = null;
                stage.load(buildCloud(code));
                parts.hint.textContent = stage.still
                    ? `Type the ${CODE_LENGTH} characters shown in the point cloud.`
                    : `Type the ${CODE_LENGTH} characters shown in the point cloud. Each one sharpens in turn; drag to look around.`;
                parts.stage.hidden = false;
                parts.refresh.hidden = false;
                parts.input.maxLength = CODE_LENGTH;
                parts.input.placeholder = 'Code';
                parts.swap.textContent = 'Use a text question';
                sizeCanvas();
                if (stage.still) {
                    stage.render(0);
                } else {
                    start();
                }
            } else {
                code = '';
                // With a backend challenge the answer stays on the server, so
                // there is nothing to compare against here.
                question = remote && remote.prompt
                    ? { prompt: remote.prompt, answers: null }
                    : textChallenge();
                stop();
                parts.hint.textContent = question.prompt;
                parts.stage.hidden = true;
                parts.refresh.hidden = true;
                parts.input.maxLength = 32;
                parts.input.placeholder = 'Answer';
                parts.swap.textContent = 'Use the point cloud';
            }

            parts.error.textContent = message || '';
        }

        // --- Interaction ---

        const observer = new ResizeObserver(function () {
            sizeCanvas();
            if (mode === 'cloud' && (stage.still || !frame)) {
                stage.render(0);
            }
        });
        observer.observe(parts.canvas);

        const visibility = new IntersectionObserver(function (entries) {
            onScreen = entries[0].isIntersecting;
            if (onScreen) {
                if (!asked) {
                    asked = true;
                    renew();
                }
                start();
            } else {
                stop();
            }
        }, { threshold: 0.01 });
        visibility.observe(parts.canvas);

        document.addEventListener('visibilitychange', function () {
            if (document.hidden) {
                stop();
            } else {
                start();
            }
        }, listen);

        stillMedia.addEventListener('change', function (event) {
            stage.still = event.matches;
            if (stage.still) {
                stop();
                stage.render(0);
            } else {
                start();
            }
        }, listen);

        let dragging = false;
        let lastX = 0;
        let lastY = 0;

        parts.canvas.addEventListener('pointerdown', function (event) {
            dragging = true;
            lastX = event.clientX;
            lastY = event.clientY;
            parts.canvas.setPointerCapture(event.pointerId);
        }, listen);

        parts.canvas.addEventListener('pointermove', function (event) {
            if (!dragging) {
                return;
            }
            event.preventDefault();
            stage.drag((event.clientX - lastX) / 260, (event.clientY - lastY) / 260);
            lastX = event.clientX;
            lastY = event.clientY;
            if (stage.still) {
                stage.render(0);
            }
        }, listen);

        ['pointerup', 'pointercancel'].forEach(function (name) {
            parts.canvas.addEventListener(name, function () {
                dragging = false;
            }, listen);
        });

        parts.refresh.addEventListener('click', function () {
            renew();
        }, listen);

        parts.swap.addEventListener('click', function () {
            mode = mode === 'cloud' ? 'text' : 'cloud';
            remote = null;
            renew(undefined, true);
        }, listen);

        parts.input.addEventListener('input', function () {
            parts.error.textContent = '';
        }, listen);

        if (form) {
            ['pointerdown', 'keydown'].forEach(function (name) {
                form.addEventListener(name, function () {
                    interacted = true;
                }, listen);
            });
        }

        // Nothing is requested until the widget is actually looked at, so a
        // visitor who never reaches the form costs the backend nothing.
        if (endpoint) {
            waiting();
        } else {
            issue();
        }

        // --- Public interface ---

        return {
            // Submitted without touching the form, or sooner after the
            // challenge appeared than anyone could read and answer it. The
            // backend applies its own minimum against the time it issued the
            // nonce; this one only saves a round trip.
            tooFast: function () {
                return !interacted || (Date.now() - started) / 1000 < MIN_FILL_SECONDS;
            },
            // Quick local feedback before posting. It can only ever say no:
            // for a backend text question the answer is not here to compare
            // against, so this passes and the backend decides.
            check: function () {
                const given = normalise(parts.input.value);
                if (given === '') {
                    return false;
                }
                if (mode === 'cloud') {
                    return given === normalise(code);
                }
                if (question.answers === null) {
                    return true;
                }
                return question.answers.some(function (answer) {
                    return normalise(answer) === given;
                });
            },
            // Throws the challenge away and asks for another. Used both for a
            // local mismatch and for a backend that rejected the nonce.
            fail: function (message) {
                renew(message || 'That did not match. Here is a new one.', true);
            },
            reset: function () {
                renew();
            },
            focus: function () {
                parts.input.focus();
            },
            // The nonce the backend issued for this challenge, empty when it
            // could not be reached and the code was generated here instead.
            nonce: function () {
                return remote ? remote.nonce : '';
            },
            response: function () {
                return parts.input.value.trim();
            },
            destroy: function () {
                stop();
                abort.abort();
                observer.disconnect();
                visibility.disconnect();
                if (trap) {
                    trap.remove();
                }
                mount.innerHTML = '';
            }
        };
    }

    window.Captcha = { attach: attach };

})(window, document);
