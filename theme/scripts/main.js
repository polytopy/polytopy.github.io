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

document.getElementById('contactForm').addEventListener('submit', function(e) {
    e.preventDefault();
    
    const formStatus = document.getElementById('formStatus');
    
    // Get form data
    const action = e.target.action
    const formData = new FormData(this);
    const name = formData.get('Name');
    const email = formData.get('Email');
    const company = formData.get('Company');
    const message = formData.get('Message');

    // Simple validation
    if (!name || !email || !message) {
        formStatus.className = `form-status error`;
        formStatus.textContent = 'Please fill in all required fields.';
        formStatus.style.display = 'block';
        return;
    }

    // Show loading state
    formStatus.className = `form-status sending`;
    formStatus.textContent = 'Sending your message...';
    formStatus.style.display = 'block';
    
    const submitBtn = this.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Sending...';
    submitBtn.disabled = true;

    fetch(action, {
      method: 'POST',
      body: formData,
    })
    .then(function (a) {
        return a.json();
    })
    .then(function (json) {
        console.log(json)
        
        const formStatus = document.getElementById('formStatus');
        if (json["result"] === "success") {
            formStatus.className = `form-status success`;
            formStatus.textContent = 'Thank you for your message! We\'ll get back to you soon.';
            formStatus.style.display = 'block';
            document.getElementById('contactForm').reset();
        }
        else {
            formStatus.className = `form-status error`;
            formStatus.textContent = 'There was an error sending your message, please try emailing instead.';
            formStatus.style.display = 'block';
        }
        
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
        
        // Hide success message after 5 seconds
        setTimeout(() => {
            formStatus.style.display = 'none';
        }, 5000);
    })
});
