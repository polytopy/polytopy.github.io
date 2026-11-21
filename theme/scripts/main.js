// Theme
const themeToggle = document.getElementById('themeToggle');
const prefersDarkScheme = window.matchMedia('(prefers-color-scheme: dark)');
const currentTheme = localStorage.getItem('theme');
if (currentTheme) {
    document.documentElement.setAttribute('data-theme', currentTheme);
} else if (prefersDarkScheme.matches) {
    document.documentElement.setAttribute('data-theme', 'dark');
}
themeToggle.addEventListener('click', function() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
});

const menuToggle = document.getElementById('menuToggle');
const navLinks = document.getElementById('navLinks');
menuToggle.addEventListener('click', function() {
    navLinks.classList.toggle('active');
});
navLinks.addEventListener('click', function(e) {
    if (e.target.tagName === 'A') {
        navLinks.classList.remove('active');
    }
});

window.addEventListener('scroll', function() {
    const header = document.getElementById('header');
    if (window.scrollY > 100) {
        header.style.background = 'rgb(from var(--white) r g b / 95%)';
        header.style.boxShadow = '0 2px 20px rgb(from var(--black) r g b / 10%)';
    } else {
        header.style.background = 'rgb(from var(--white) r g b / 50%)';
        header.style.boxShadow = 'none';
    }
});

document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});

// If captcha.js is missing or its mount point is gone, fall back to a stub
// that waves everything through rather than taking the whole form down with it.
const captcha = (window.Captcha && window.Captcha.attach('#captchaMount')) || {
    tooFast: function () { return false; },
    check: function () { return true; },
    fail: function () {},
    reset: function () {},
    nonce: function () { return ''; },
    response: function () { return ''; }
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// The status sits above the form, so after a send from the bottom of a long
// form it is off screen. Centre it rather than aligning to the top: the header
// is fixed, and would cover it.
function showStatus(kind, text) {
    const formStatus = document.getElementById('formStatus');
    formStatus.className = `form-status ${kind}`;
    formStatus.textContent = text;
    formStatus.style.display = 'block';
    formStatus.scrollIntoView({
        behavior: reducedMotion.matches ? 'auto' : 'smooth',
        block: 'center'
    });
}

// #captchaAnswer is left alone: the captcha widget disables it while it is
// fetching the next challenge and re-enables it when one arrives, which can be
// after this does. Two owners for one disabled flag would fight.
function setBusy(form, busy) {
    form.classList.toggle('is-busy', busy);
    form.setAttribute('aria-busy', busy ? 'true' : 'false');
    Array.prototype.forEach.call(form.elements, function (control) {
        if (control.id !== 'captchaAnswer') {
            control.disabled = busy;
        }
    });
}

document.getElementById('contactForm').addEventListener('submit', function(e) {
    e.preventDefault();

    const formStatus = document.getElementById('formStatus');
    const form = this;

    // Get form data
    const action = e.target.action
    const formData = new FormData(this);
    const name = formData.get('Name');
    const email = formData.get('Email');
    const company = formData.get('Company');
    const message = formData.get('Message');

    // Simple validation
    if (!name || !email || !message) {
        showStatus('error', 'Please fill in all required fields.');
        return;
    }

    if (captcha.tooFast() || !captcha.check()) {
        showStatus('error', 'The human check did not pass, please try the new one.');
        captcha.fail();
        return;
    }

    document.getElementById('captchaNonce').value = captcha.nonce();
    document.getElementById('captchaResponse').value = captcha.response();

    // Rebuilt so it picks up the hidden fields just filled in. The honeypot
    // goes with it on purpose: the backend is the one that should see it.
    const payload = new FormData(this);

    showStatus('sending', 'Sending your message...');

    const submitBtn = this.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Sending...';
    setBusy(form, true);

    // Holds the form shut for a moment after the answer lands, so the result
    // is read rather than typed straight over.
    function settle() {
        submitBtn.textContent = originalText;
        window.setTimeout(function () {
            setBusy(form, false);
        }, 1000);
    }

    fetch(action, {
      method: 'POST',
      body: payload,
    })
    .then(function (a) {
        return a.json();
    })
    .then(function (json) {
        console.log(json)

        if (json["result"] === "success") {
            showStatus('success', 'Thank you for your message! We\'ll get back to you soon.');
            form.reset();
            captcha.reset();
        }
        else if (json["result"] === "challenge") {
            showStatus('error', 'The human check did not pass, please try the new one.');
            captcha.fail(json["error"]);
        }
        else {
            showStatus('error', json["error"] || 'There was an error sending your message, please try emailing instead.');
            captcha.reset();
        }

        settle();

        // Hide success message after 5 seconds
        setTimeout(() => {
            formStatus.style.display = 'none';
        }, 5000);
    })
    .catch(function (error) {
        console.log(error)

        showStatus('error', 'There was an error sending your message, please try emailing instead.');
        settle();
        captcha.reset();
    })
});
