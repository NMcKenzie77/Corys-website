(function () {
  'use strict';

  var GATE_KEY = 'yb_age_verified_v1';
  var gate = document.getElementById('gate');
  var site = document.getElementById('site');
  var enterBtn = document.getElementById('gate-enter');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------
  // SMOKE EFFECT — reusable canvas particle system.
  // Used for the gate (full intensity) and the hero (subtle, ambient).
  // Lightweight (no libraries), respects prefers-reduced-motion.
  // ---------------------------------------------------------------
  function createSmoke(canvasId, opts) {
    var canvas = document.getElementById(canvasId);
    var ctx = canvas ? canvas.getContext('2d') : null;
    var particles = [];
    var animationFrame = null;
    var intensity = 1;
    var maxParticles = opts.density || 26;
    var baseOpacity = opts.opacity || 0.05;

    function resize() {
      if (!canvas) return;
      var rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
    }

    function makeParticle(startAtBottom) {
      var w = canvas.width;
      var h = canvas.height;
      return {
        x: Math.random() * w,
        y: startAtBottom ? h + Math.random() * 100 : h + Math.random() * h,
        r: 60 + Math.random() * 140,
        speed: 0.2 + Math.random() * 0.45,
        drift: (Math.random() - 0.5) * 0.4,
        opacity: baseOpacity * (0.5 + Math.random()),
        wobble: Math.random() * Math.PI * 2
      };
    }

    function init() {
      if (!canvas) return;
      particles = [];
      var count = window.innerWidth < 700 ? Math.round(maxParticles * 0.55) : maxParticles;
      for (var i = 0; i < count; i++) particles.push(makeParticle(false));
    }

    function draw() {
      if (!ctx || !canvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.y -= p.speed * intensity;
        p.wobble += 0.01;
        p.x += Math.sin(p.wobble) * p.drift;

        var fade = 1;
        var fadeZone = canvas.height * 0.35;
        if (p.y < fadeZone) fade = Math.max(0, p.y / fadeZone);

        var gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        gradient.addColorStop(0, 'rgba(200,255,205,' + (p.opacity * fade) + ')');
        gradient.addColorStop(1, 'rgba(200,255,205,0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();

        if (p.y + p.r < 0) particles[i] = makeParticle(true);
      }

      animationFrame = requestAnimationFrame(draw);
    }

    function start() {
      if (!canvas || reduceMotion) return;
      resize();
      init();
      if (!animationFrame) draw();
    }

    function stop() {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
    }

    function setIntensity(v) { intensity = v; }

    window.addEventListener('resize', resize);

    return { start: start, stop: stop, setIntensity: setIntensity };
  }

  var gateSmoke = createSmoke('smoke-canvas', { density: 26, opacity: 0.05 });
  var heroSmoke = createSmoke('hero-smoke-canvas', { density: 12, opacity: 0.035 });

  // ---------------------------------------------------------------
  // GATE LOGIC
  // ---------------------------------------------------------------
  function passGate(skipAnimation) {
    if (!skipAnimation) {
      gateSmoke.setIntensity(3.2); // brief plume surge on entry
      setTimeout(function () { gateSmoke.setIntensity(1); }, 1200);
    }
    gate.classList.add('is-leaving');
    site.classList.add('is-visible');
    document.body.style.overflow = '';
    try { localStorage.setItem(GATE_KEY, '1'); } catch (e) { /* ignore storage errors */ }
    setTimeout(gateSmoke.stop, 1000);
    heroSmoke.start();
  }

  var alreadyVerified = false;
  try { alreadyVerified = localStorage.getItem(GATE_KEY) === '1'; } catch (e) { /* ignore */ }

  if (alreadyVerified) {
    passGate(true);
  } else {
    document.body.style.overflow = 'hidden';
    gateSmoke.start();
  }

  if (enterBtn) {
    enterBtn.addEventListener('click', function () {
      passGate(false);
    });
  }

  // ---------------------------------------------------------------
  // SCROLL REVEAL — fades/slides elements in as they enter the viewport.
  // ---------------------------------------------------------------
  var revealEls = document.querySelectorAll('[data-reveal]');
  if (revealEls.length) {
    revealEls.forEach(function (el) {
      var delay = el.getAttribute('data-reveal-delay');
      if (delay) el.style.setProperty('--reveal-delay', delay);
    });

    if ('IntersectionObserver' in window) {
      var revealObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in-view');
            revealObserver.unobserve(entry.target);
          }
        });
      }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

      revealEls.forEach(function (el) { revealObserver.observe(el); });
    } else {
      // No IntersectionObserver support — just show everything.
      revealEls.forEach(function (el) { el.classList.add('is-in-view'); });
    }
  }

  // ---------------------------------------------------------------
  // COUNT-UP NUMBERS — animates once its parent reveals.
  // ---------------------------------------------------------------
  var countEls = document.querySelectorAll('[data-count-to]');
  if (countEls.length && !reduceMotion) {
    countEls.forEach(function (el) {
      var target = parseInt(el.getAttribute('data-count-to'), 10) || 0;
      var suffix = el.getAttribute('data-count-suffix') || '';
      var started = false;

      function run() {
        if (started) return;
        started = true;
        var start = null;
        var duration = 900;
        function step(ts) {
          if (!start) start = ts;
          var progress = Math.min((ts - start) / duration, 1);
          var value = Math.round(progress * target);
          el.textContent = value + suffix;
          if (progress < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      }

      if ('IntersectionObserver' in window) {
        var obs = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) { run(); obs.unobserve(entry.target); }
          });
        }, { threshold: 0.5 });
        obs.observe(el);
      } else {
        run();
      }
    });
  }

  // ---------------------------------------------------------------
  // PARALLAX — subtle depth on scroll for elements with data-parallax.
  // ---------------------------------------------------------------
  var parallaxEls = document.querySelectorAll('[data-parallax]');
  if (parallaxEls.length && !reduceMotion) {
    var parallaxTicking = false;

    function updateParallax() {
      var viewportH = window.innerHeight;
      parallaxEls.forEach(function (el) {
        var factor = parseFloat(el.getAttribute('data-parallax')) || 0.1;
        var rect = el.getBoundingClientRect();
        var centerOffset = (rect.top + rect.height / 2) - viewportH / 2;
        el.style.transform = 'translateY(' + (centerOffset * -factor * 0.15) + 'px)';
      });
      parallaxTicking = false;
    }

    window.addEventListener('scroll', function () {
      if (!parallaxTicking) {
        requestAnimationFrame(updateParallax);
        parallaxTicking = true;
      }
    }, { passive: true });
    updateParallax();
  }

  // ---------------------------------------------------------------
  // 3D TILT CARDS — cursor-reactive tilt on category cards and steps.
  // ---------------------------------------------------------------
  var tiltEls = document.querySelectorAll('[data-tilt]');
  if (tiltEls.length && !reduceMotion && window.matchMedia('(hover: hover)').matches) {
    tiltEls.forEach(function (el) {
      el.addEventListener('mousemove', function (e) {
        var rect = el.getBoundingClientRect();
        var x = (e.clientX - rect.left) / rect.width - 0.5;
        var y = (e.clientY - rect.top) / rect.height - 0.5;
        var rotateX = (-y * 10).toFixed(2);
        var rotateY = (x * 10).toFixed(2);
        el.style.transform = 'perspective(800px) rotateX(' + rotateX + 'deg) rotateY(' + rotateY + 'deg) translateY(-4px)';
      });
      el.addEventListener('mouseleave', function () {
        el.style.transform = '';
      });
    });
  }

  // ---------------------------------------------------------------
  // MAGNETIC BUTTONS — buttons drift slightly toward the cursor.
  // ---------------------------------------------------------------
  var magneticEls = document.querySelectorAll('[data-magnetic]');
  if (magneticEls.length && !reduceMotion && window.matchMedia('(hover: hover)').matches) {
    magneticEls.forEach(function (el) {
      var maxPull = 10;
      el.addEventListener('mousemove', function (e) {
        var rect = el.getBoundingClientRect();
        var x = (e.clientX - rect.left) / rect.width - 0.5;
        var y = (e.clientY - rect.top) / rect.height - 0.5;
        el.style.transform = 'translate(' + (x * maxPull).toFixed(1) + 'px, ' + (y * maxPull).toFixed(1) + 'px)';
      });
      el.addEventListener('mouseleave', function () {
        el.style.transform = '';
      });
    });
  }

  // ---------------------------------------------------------------
  // NAV SCROLL STATE — compact + shadow once the page scrolls.
  // ---------------------------------------------------------------
  var navEl = document.getElementById('site-nav');
  if (navEl) {
    function updateNavState() {
      if (window.scrollY > 24) navEl.classList.add('is-scrolled');
      else navEl.classList.remove('is-scrolled');
    }
    window.addEventListener('scroll', updateNavState, { passive: true });
    updateNavState();
  }

  // ---------------------------------------------------------------
  // HERO WORD CYCLER
  // ---------------------------------------------------------------
  var words = document.querySelectorAll('.hero-cycle-word');
  if (words.length) {
    var activeIndex = 0;
    setInterval(function () {
      words[activeIndex].classList.remove('is-active');
      activeIndex = (activeIndex + 1) % words.length;
      words[activeIndex].classList.add('is-active');
    }, 2200);
  }

  // ---------------------------------------------------------------
  // FOOTER YEAR
  // ---------------------------------------------------------------
  var yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // ---------------------------------------------------------------
  // WHOLESALE INQUIRY FORM
  // ---------------------------------------------------------------
  var form = document.getElementById('inquiry-form');
  var status = document.getElementById('form-status');

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var formData = new FormData(form);
      var payload = {};
      formData.forEach(function (value, key) { payload[key] = value; });

      status.textContent = 'Sending...';
      status.className = 'form-status';

      fetch('/api/inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (result) {
          if (result.ok && result.data.ok) {
            status.textContent = "Request sent. We'll follow up shortly.";
            status.className = 'form-status success';
            form.reset();
          } else {
            status.textContent = (result.data && result.data.error) || 'Something went wrong. Please try again.';
            status.className = 'form-status error';
          }
        })
        .catch(function () {
          status.textContent = 'Network error — please try again in a moment.';
          status.className = 'form-status error';
        });
    });
  }
})();
