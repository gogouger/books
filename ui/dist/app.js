"use strict";
(() => {
  // src/api.ts
  var API_BASE = "/api";
  async function apiFetch(path, options = {}) {
    const token = getToken();
    const headers = {
      ...options.headers || {}
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    if (!(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }
    const resp = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers
    });
    if (resp.status === 401) {
      const refreshed = await showLoginPrompt();
      if (!refreshed) {
        clearAuth();
        window.location.href = "/";
      }
      throw new Error("Not authenticated");
    }
    if (resp.status === 403) {
      throw new Error("Not authorized");
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || "Request failed");
    }
    return resp.json();
  }
  async function apiFetchRaw(path, options = {}) {
    const token = getToken();
    const headers = {
      ...options.headers || {}
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const resp = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers
    });
    if (resp.status === 401) {
      const refreshed = await showLoginPrompt();
      if (!refreshed) {
        clearAuth();
        window.location.href = "/";
      }
      throw new Error("Not authenticated");
    }
    if (!resp.ok) {
      throw new Error(`Download failed: ${resp.statusText}`);
    }
    return resp;
  }
  var api = {
    async getMe() {
      return apiFetch("/auth/me");
    },
    async updateKindleEmail(email) {
      return apiFetch("/auth/me/kindle", {
        method: "PATCH",
        body: JSON.stringify({ kindle_email: email })
      });
    },
    async getBooks(username2, params = {}) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== void 0 && v !== null && v !== "") {
          qs.set(k, String(v));
        }
      }
      return apiFetch(`/${username2}/books?${qs.toString()}`);
    },
    async getBook(username2, id) {
      return apiFetch(`/${username2}/books/${id}`);
    },
    async updateBook(username2, id, updates) {
      return apiFetch(`/${username2}/books/${id}`, {
        method: "PATCH",
        body: JSON.stringify(updates)
      });
    },
    async deleteBook(username2, id) {
      return apiFetch(`/${username2}/books/${id}`, { method: "DELETE" });
    },
    async sendToKindle(username2, bookId, email) {
      return apiFetch(`/${username2}/books/${bookId}/kindle`, {
        method: "POST",
        body: JSON.stringify(email ? { email } : {})
      });
    },
    async getSeries(username2) {
      return apiFetch(`/${username2}/series`);
    },
    async getSeriesBooks(username2, name) {
      return apiFetch(`/${username2}/series/${encodeURIComponent(name)}`);
    },
    async searchMetadata(username2, query, source = "google") {
      return apiFetch(`/${username2}/metadata/search`, {
        method: "POST",
        body: JSON.stringify({ query, source })
      });
    },
    async uploadBook(username2, file, metadata) {
      const formData = new FormData();
      formData.append("file", file);
      const qs = new URLSearchParams();
      if (metadata) {
        for (const [k, v] of Object.entries(metadata)) {
          if (v !== void 0 && v !== null && v !== "") {
            qs.set(k, String(v));
          }
        }
      }
      const token = getToken();
      const headers = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const resp = await fetch(`${API_BASE}/${username2}/books?${qs.toString()}`, {
        method: "POST",
        headers,
        body: formData
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail || "Upload failed");
      }
      return resp.json();
    },
    coverUrl(userId, coverFilename) {
      return `/covers/${userId}/${coverFilename}`;
    },
    async downloadFile(username2, bookId, title) {
      const resp = await apiFetchRaw(`/${username2}/books/${bookId}/file`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title}.epub`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  // src/auth.ts
  var GOOGLE_CLIENT_ID = "110972621303-tb5jjugmk28id2mu3ttnpvmecu89b6ak.apps.googleusercontent.com";
  var TOKEN_KEY = "books_id_token";
  var googleInitialized = false;
  var tokenRefreshTimeout = null;
  function decodeToken(token) {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return {};
      const payload = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
      return JSON.parse(payload);
    } catch {
      return {};
    }
  }
  function scheduleTokenRefresh(token) {
    if (tokenRefreshTimeout) clearTimeout(tokenRefreshTimeout);
    const decoded = decodeToken(token);
    const exp = Number(decoded.exp);
    if (!exp) return;
    const timeUntilExpiry = exp * 1e3 - Date.now() - 5 * 60 * 1e3;
    if (timeUntilExpiry <= 0) {
      clearAuth();
      window.location.href = "/";
      return;
    }
    tokenRefreshTimeout = setTimeout(() => {
      showLoginPrompt();
    }, timeUntilExpiry);
  }
  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY);
  }
  function setToken(token) {
    sessionStorage.setItem(TOKEN_KEY, token);
    scheduleTokenRefresh(token);
  }
  function clearAuth() {
    if (tokenRefreshTimeout) clearTimeout(tokenRefreshTimeout);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem("books_user");
    if (typeof google !== "undefined" && google.accounts && google.accounts.id) {
      google.accounts.id.disableAutoSelect();
    }
  }
  function getUser() {
    const raw = sessionStorage.getItem("books_user");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  function setUser(user) {
    sessionStorage.setItem("books_user", JSON.stringify(user));
  }
  async function waitForGoogleApi() {
    if (typeof google !== "undefined" && google.accounts && google.accounts.id) return;
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (typeof google !== "undefined" && google.accounts && google.accounts.id) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 1e4);
    });
  }
  async function initializeGoogleSignIn() {
    if (googleInitialized) return;
    await waitForGoogleApi();
    if (typeof google === "undefined" || !google.accounts || !google.accounts.id) return;
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: async (response) => {
        setToken(response.credential);
        try {
          const me = await apiFetch("/auth/me");
          setUser(me);
          window.location.href = `/${me.username}/`;
        } catch (err) {
          clearAuth();
          const errorEl = document.getElementById("login-error");
          if (errorEl) {
            errorEl.textContent = err.message || "Login failed";
            errorEl.classList.remove("d-none");
          }
        }
      },
      auto_select: false
    });
    googleInitialized = true;
  }
  async function renderGoogleButton(containerId) {
    await initializeGoogleSignIn();
    if (typeof google === "undefined" || !google.accounts || !google.accounts.id) return;
    const container = document.getElementById(containerId);
    if (!container) return;
    google.accounts.id.renderButton(container, {
      theme: "filled_black",
      size: "large",
      type: "standard",
      shape: "rectangular"
    });
  }
  async function showLoginPrompt() {
    await initializeGoogleSignIn();
    if (!googleInitialized) return false;
    return new Promise((resolve) => {
      google.accounts.id.prompt((notification) => {
        if (notification.isSkippedMoment() || notification.isDismissedMoment()) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }
  function bootstrapAuth() {
    const token = getToken();
    if (token) {
      scheduleTokenRefresh(token);
    }
  }

  // src/context.ts
  function getLibraryUsername() {
    const match = window.location.pathname.match(
      /^\/([a-zA-Z0-9_-]+)\/?/
    );
    return match ? match[1] : null;
  }
  function isOwner() {
    const libraryUser = getLibraryUsername();
    if (!libraryUser) return false;
    const me = getUser();
    if (!me) return false;
    return me.username === libraryUser;
  }

  // src/router.ts
  var routes = [];
  var defaultHandler = null;
  function addRoute(path, handler) {
    const keys = [];
    const pattern = path.replace(/:([^/]+)/g, (_match, key) => {
      keys.push(key);
      return "([^/]+)";
    });
    routes.push({
      pattern: new RegExp(`^${pattern}$`),
      keys,
      handler
    });
  }
  function setDefaultRoute(handler) {
    defaultHandler = handler;
  }
  function navigate(hash) {
    window.location.hash = hash;
  }
  function navigateHome() {
    history.pushState(null, "", window.location.pathname);
    handleRoute();
  }
  var handleRoute;
  function startRouter() {
    handleRoute = () => {
      const hash = window.location.hash.slice(1);
      if (hash) {
        for (const route of routes) {
          const match = hash.match(route.pattern);
          if (match) {
            const params = {};
            route.keys.forEach((key, i) => {
              params[key] = decodeURIComponent(match[i + 1]);
            });
            route.handler(params);
            updateActiveNav(hash);
            return;
          }
        }
      }
      if (defaultHandler) {
        if (window.location.hash) {
          history.replaceState(null, "", window.location.pathname);
        }
        defaultHandler({});
        updateActiveNav("");
      }
    };
    window.addEventListener("hashchange", handleRoute);
    handleRoute();
  }
  function updateActiveNav(hash) {
    document.querySelectorAll("#nav-links .nav-link").forEach((link) => {
      const href = link.getAttribute("href") || "";
      if (!href || href === "#") {
        link.classList.toggle("active", !hash);
      } else {
        const isActive = hash.startsWith(href.slice(1));
        link.classList.toggle("active", isActive);
      }
    });
  }

  // src/pages/login.ts
  function renderLogin() {
    const app = document.getElementById("app");
    app.innerHTML = `
        <div class="login-container">
            <div class="card shadow-sm">
                <div class="card-body p-4">
                    <h3 class="text-center mb-4">
                        <i class="bi bi-book"></i> Books
                    </h3>
                    <div id="login-error" class="alert alert-danger d-none"></div>
                    <div id="google-signin-button" class="d-flex justify-content-center"></div>
                </div>
            </div>
        </div>
    `;
    renderGoogleButton("google-signin-button");
  }
  function updateNavbar() {
    const user = getUser();
    const libraryUser = getLibraryUsername();
    const navLinks = document.getElementById("nav-links");
    const navUser = document.getElementById("nav-user");
    const navUsername = document.getElementById("nav-username");
    const navLogout = document.getElementById("nav-logout");
    const navSignin = document.getElementById("nav-signin");
    const navMyLibrary = document.getElementById("nav-my-library");
    const navAddItem = document.getElementById("nav-add-item");
    navLinks.style.display = "none";
    navUser.style.display = "none";
    navAddItem.style.display = "none";
    navUsername.textContent = "";
    navLogout.classList.add("d-none");
    navSignin.classList.add("d-none");
    navMyLibrary.classList.add("d-none");
    if (!libraryUser) {
      if (user) {
        navUser.style.display = "";
        navUsername.textContent = user.display_name;
        navLogout.classList.remove("d-none");
        navLogout.onclick = (e) => {
          e.preventDefault();
          clearAuth();
          window.location.href = "/";
        };
      }
      return;
    }
    navLinks.style.display = "";
    navUser.style.display = "";
    const isOwner2 = user && user.username === libraryUser;
    if (isOwner2) {
      navAddItem.style.display = "";
      navUsername.textContent = user.display_name;
      navLogout.classList.remove("d-none");
      navLogout.onclick = (e) => {
        e.preventDefault();
        clearAuth();
        window.location.href = "/";
      };
    } else if (user) {
      navMyLibrary.classList.remove("d-none");
      navMyLibrary.href = `/${user.username}/`;
      navUsername.textContent = user.display_name;
      navLogout.classList.remove("d-none");
      navLogout.onclick = (e) => {
        e.preventDefault();
        clearAuth();
        window.location.href = "/";
      };
    } else {
      navSignin.classList.remove("d-none");
    }
  }

  // src/components/rating-stars.ts
  function ratingStarsHtml(rating, editable = false) {
    const r = rating || 0;
    let html = `<div class="rating-stars${editable ? " editable" : ""}" data-rating="${r}">`;
    for (let i = 1; i <= 5; i++) {
      if (r >= i) {
        html += `<i class="bi bi-star-fill star filled" data-value="${i}"></i>`;
      } else if (r >= i - 0.5) {
        html += `<i class="bi bi-star-half star filled" data-value="${i - 0.5}"></i>`;
      } else {
        html += `<i class="bi bi-star star" data-value="${i}"></i>`;
      }
    }
    html += "</div>";
    return html;
  }
  function attachRatingHandler(container, callback) {
    const starsDiv = container.querySelector(".rating-stars.editable");
    if (!starsDiv) return;
    starsDiv.addEventListener("click", (e) => {
      const target = e.target;
      if (!target.classList.contains("star")) return;
      const value = parseFloat(target.dataset.value || "0");
      const currentRating = parseFloat(
        starsDiv.getAttribute("data-rating") || "0"
      );
      let newRating;
      if (value === currentRating) {
        newRating = value - 0.5;
      } else if (value - 0.5 === currentRating) {
        newRating = 0;
      } else {
        newRating = value;
      }
      starsDiv.setAttribute("data-rating", String(newRating));
      starsDiv.innerHTML = "";
      const temp = document.createElement("div");
      temp.innerHTML = ratingStarsHtml(newRating, true);
      const newStars = temp.querySelector(".rating-stars");
      if (newStars) {
        starsDiv.innerHTML = newStars.innerHTML;
      }
      callback(newRating);
    });
  }

  // src/components/book-card.ts
  function bookCardHtml(book) {
    const coverImg = book.cover_filename ? `<img src="${api.coverUrl(book.user_id, book.cover_filename)}"
               alt="${escapeHtml(book.title)}" loading="lazy">` : `<div class="no-cover"><i class="bi bi-book"></i></div>`;
    const readBadge = book.is_read ? '<span class="badge bg-success read-badge">Read</span>' : "";
    const seriesInfo = book.series ? `<div class="card-series">${escapeHtml(book.series)}${book.series_index ? ` #${book.series_index}` : ""}</div>` : "";
    const stars = book.rating ? ratingStarsHtml(book.rating) : "";
    return `
        <div class="book-card card" data-book-id="${book.id}" role="button">
            <div class="cover-container">
                ${coverImg}
                ${readBadge}
            </div>
            <div class="card-body">
                <div class="card-title">${escapeHtml(book.title)}</div>
                <div class="card-author">${escapeHtml(book.authors)}</div>
                ${seriesInfo}
                ${stars}
            </div>
        </div>
    `;
  }
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // src/components/book-grid.ts
  function bookGridHtml(books) {
    if (books.length === 0) {
      return `
            <div class="text-center text-muted py-5">
                <i class="bi bi-book" style="font-size: 3rem;"></i>
                <p class="mt-2">No books found</p>
            </div>
        `;
    }
    const cards = books.map((b) => bookCardHtml(b)).join("");
    return `<div class="book-grid">${cards}</div>`;
  }
  function attachGridClickHandlers(container) {
    container.querySelectorAll(".book-card").forEach((card) => {
      card.addEventListener("click", () => {
        const bookId = card.getAttribute("data-book-id");
        if (bookId) navigate(`#/book/${bookId}`);
      });
    });
  }

  // src/components/filter-bar.ts
  function filterBarHtml(state) {
    return `
        <div class="filter-bar">
            <div class="row g-2 align-items-end">
                <div class="col-12 col-md-4">
                    <input type="text" class="form-control" id="filter-search"
                           placeholder="Search title or author..."
                           value="${escapeAttr(state.q)}">
                </div>
                <div class="col-6 col-md-2">
                    <select class="form-select" id="filter-read">
                        <option value=""${state.is_read === "" ? " selected" : ""}>All books</option>
                        <option value="1"${state.is_read === "1" ? " selected" : ""}>Read</option>
                        <option value="0"${state.is_read === "0" ? " selected" : ""}>Unread</option>
                    </select>
                </div>
                <div class="col-6 col-md-2">
                    <select class="form-select" id="filter-sort">
                        <option value="title"${state.sort === "title" ? " selected" : ""}>Title</option>
                        <option value="author"${state.sort === "author" ? " selected" : ""}>Author</option>
                        <option value="date_added"${state.sort === "date_added" ? " selected" : ""}>Date added</option>
                        <option value="rating"${state.sort === "rating" ? " selected" : ""}>Rating</option>
                        <option value="series"${state.sort === "series" ? " selected" : ""}>Series</option>
                    </select>
                </div>
                <div class="col-6 col-md-2">
                    <select class="form-select" id="filter-order">
                        <option value="asc"${state.order === "asc" ? " selected" : ""}>A-Z / Asc</option>
                        <option value="desc"${state.order === "desc" ? " selected" : ""}>Z-A / Desc</option>
                    </select>
                </div>
                <div class="col-6 col-md-2 text-end">
                    <span class="pagination-info" id="book-count"></span>
                </div>
            </div>
        </div>
    `;
  }
  function attachFilterHandlers(container, onChange) {
    let debounceTimer;
    const getState = () => ({
      q: container.querySelector("#filter-search")?.value || "",
      is_read: container.querySelector("#filter-read")?.value || "",
      sort: container.querySelector("#filter-sort")?.value || "title",
      order: container.querySelector("#filter-order")?.value || "asc"
    });
    const searchInput = container.querySelector("#filter-search");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => onChange(getState()), 300);
      });
    }
    ["#filter-read", "#filter-sort", "#filter-order"].forEach((sel) => {
      const el = container.querySelector(sel);
      if (el) el.addEventListener("change", () => onChange(getState()));
    });
  }
  function escapeAttr(text) {
    return text.replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  // src/pages/library.ts
  var currentState = {
    q: "",
    is_read: "",
    sort: "title",
    order: "asc"
  };
  var currentOffset = 0;
  var PAGE_SIZE = 60;
  async function renderLibrary() {
    const app = document.getElementById("app");
    app.innerHTML = filterBarHtml(currentState) + '<div id="book-grid-container"></div><div id="pagination-container" class="d-flex justify-content-center mt-3 mb-4"></div>';
    attachFilterHandlers(app, async (state) => {
      currentState = state;
      currentOffset = 0;
      await loadBooks();
    });
    await loadBooks();
  }
  async function loadBooks() {
    const username2 = getLibraryUsername();
    const gridContainer = document.getElementById("book-grid-container");
    const paginationContainer = document.getElementById("pagination-container");
    const countEl = document.getElementById("book-count");
    gridContainer.innerHTML = `
        <div class="loading-spinner">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
        </div>
    `;
    try {
      const params = {
        sort: currentState.sort,
        order: currentState.order,
        limit: PAGE_SIZE,
        offset: currentOffset
      };
      if (currentState.q) params.q = currentState.q;
      if (currentState.is_read !== "") params.is_read = currentState.is_read;
      const data = await api.getBooks(username2, params);
      gridContainer.innerHTML = bookGridHtml(data.books);
      attachGridClickHandlers(gridContainer);
      if (countEl) {
        countEl.textContent = `${data.total} book${data.total !== 1 ? "s" : ""}`;
      }
      const totalPages = Math.ceil(data.total / PAGE_SIZE);
      const currentPage = Math.floor(currentOffset / PAGE_SIZE) + 1;
      if (totalPages > 1) {
        paginationContainer.innerHTML = paginationHtml(currentPage, totalPages);
        attachPaginationHandlers(paginationContainer, totalPages);
      } else {
        paginationContainer.innerHTML = "";
      }
    } catch (err) {
      gridContainer.innerHTML = `
            <div class="alert alert-danger">
                Failed to load books: ${err.message}
            </div>
        `;
    }
  }
  function paginationHtml(current, total) {
    let html = '<nav><ul class="pagination pagination-sm">';
    html += `<li class="page-item${current === 1 ? " disabled" : ""}">
        <a class="page-link" href="#" data-page="${current - 1}">Prev</a></li>`;
    const start = Math.max(1, current - 2);
    const end = Math.min(total, current + 2);
    if (start > 1) {
      html += `<li class="page-item"><a class="page-link" href="#" data-page="1">1</a></li>`;
      if (start > 2) html += '<li class="page-item disabled"><span class="page-link">...</span></li>';
    }
    for (let i = start; i <= end; i++) {
      html += `<li class="page-item${i === current ? " active" : ""}">
            <a class="page-link" href="#" data-page="${i}">${i}</a></li>`;
    }
    if (end < total) {
      if (end < total - 1) html += '<li class="page-item disabled"><span class="page-link">...</span></li>';
      html += `<li class="page-item"><a class="page-link" href="#" data-page="${total}">${total}</a></li>`;
    }
    html += `<li class="page-item${current === total ? " disabled" : ""}">
        <a class="page-link" href="#" data-page="${current + 1}">Next</a></li>`;
    html += "</ul></nav>";
    return html;
  }
  function attachPaginationHandlers(container, totalPages) {
    container.querySelectorAll(".page-link[data-page]").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const page = parseInt(
          e.target.dataset.page || "1"
        );
        if (page >= 1 && page <= totalPages) {
          currentOffset = (page - 1) * PAGE_SIZE;
          loadBooks();
          window.scrollTo(0, 0);
        }
      });
    });
  }

  // src/pages/book-detail.ts
  async function renderBookDetail(params) {
    const app = document.getElementById("app");
    const bookId = parseInt(params.id);
    const username2 = getLibraryUsername();
    app.innerHTML = `
        <div class="loading-spinner">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
        </div>
    `;
    try {
      const book = await api.getBook(username2, bookId);
      renderBook(app, book, username2);
    } catch (err) {
      app.innerHTML = `
            <div class="alert alert-danger">
                Failed to load book: ${err.message}
            </div>
        `;
    }
  }
  function renderBook(app, book, username2) {
    const isOwner2 = book.is_owner;
    const coverHtml = book.cover_filename ? `<img src="${api.coverUrl(book.user_id, book.cover_filename)}"
               alt="${escapeHtml2(book.title)}" class="cover-large">` : `<div class="no-cover-large"><i class="bi bi-book"></i></div>`;
    const tagsHtml = (book.tags || []).map((t) => `<span class="badge bg-secondary tag-badge">${escapeHtml2(t)}</span>`).join("");
    const seriesLink = book.series ? `<a href="#/series/${encodeURIComponent(book.series)}">${escapeHtml2(book.series)}</a>${book.series_index ? ` #${book.series_index}` : ""}` : '<span class="text-muted">-</span>';
    const ratingHtml = ratingStarsHtml(book.rating, isOwner2);
    const statusHtml = isOwner2 ? `<div class="form-check form-switch">
               <input class="form-check-input" type="checkbox"
                      id="read-toggle" ${book.is_read ? "checked" : ""}>
               <label class="form-check-label" for="read-toggle">
                   ${book.is_read ? "Read" : "Unread"}
               </label>
           </div>` : `<span>${book.is_read ? "Read" : "Unread"}</span>`;
    const dateVal = book.date_finished ? book.date_finished.split("T")[0] : "";
    const dateHtml = isOwner2 ? `<input type="date" class="form-control form-control-sm"
                  id="date-finished" style="width: 200px;"
                  value="${dateVal}">` : `<span>${dateVal ? formatDate(book.date_finished) : '<span class="text-muted">-</span>'}</span>`;
    const actionsHtml = isOwner2 ? `<div class="mt-3 d-flex gap-2 flex-wrap">
               ${book.file_path ? `
                   <button class="btn btn-outline-primary btn-sm" id="download-btn">
                       <i class="bi bi-download"></i> Download EPUB
                   </button>
                   <button class="btn btn-outline-warning btn-sm" id="kindle-btn">
                       <i class="bi bi-send"></i> Send to Kindle
                   </button>
               ` : ""}
               <button class="btn btn-outline-danger btn-sm" id="delete-btn">
                   <i class="bi bi-trash"></i> Delete
               </button>
           </div>` : "";
    app.innerHTML = `
        <div class="book-detail">
            <a href="#" class="btn btn-outline-secondary btn-sm mb-3" id="back-to-library">
                <i class="bi bi-arrow-left"></i> Back to Library
            </a>

            <div class="row">
                <div class="col-auto">
                    ${coverHtml}
                </div>
                <div class="col">
                    <h2>${escapeHtml2(book.title)}</h2>
                    <h5 class="text-muted">${escapeHtml2(book.authors)}</h5>

                    <table class="table metadata-table mt-3">
                        <tbody>
                            <tr>
                                <th>Rating</th>
                                <td id="rating-container">
                                    ${ratingHtml}
                                </td>
                            </tr>
                            <tr>
                                <th>Status</th>
                                <td>${statusHtml}</td>
                            </tr>
                            <tr>
                                <th>Date Finished</th>
                                <td>${dateHtml}</td>
                            </tr>
                            <tr>
                                <th>Series</th>
                                <td>${seriesLink}</td>
                            </tr>
                            <tr>
                                <th>ISBN</th>
                                <td>${book.isbn || '<span class="text-muted">-</span>'}</td>
                            </tr>
                            <tr>
                                <th>Goodreads</th>
                                <td>${book.goodreads_id ? `<a href="https://www.goodreads.com/book/show/${book.goodreads_id}" target="_blank" rel="noopener">${book.goodreads_id}</a>` : '<span class="text-muted">-</span>'}</td>
                            </tr>
                            <tr>
                                <th>Tags</th>
                                <td>${tagsHtml || '<span class="text-muted">-</span>'}</td>
                            </tr>
                            <tr>
                                <th>Added</th>
                                <td>${formatDate(book.date_added)}</td>
                            </tr>
                        </tbody>
                    </table>

                    ${actionsHtml}

                    <div id="action-alert" class="mt-2"></div>
                </div>
            </div>

            ${book.description ? `
                <div class="mt-4">
                    <h5>Description</h5>
                    <div class="card card-body bg-white">
                        ${book.description}
                    </div>
                </div>
            ` : ""}
        </div>
    `;
    document.getElementById("back-to-library").addEventListener("click", (e) => {
      e.preventDefault();
      navigateHome();
    });
    if (!isOwner2) return;
    attachRatingHandler(
      document.getElementById("rating-container"),
      async (rating) => {
        try {
          await api.updateBook(username2, book.id, { rating });
          showAlert("Rating updated", "success");
        } catch (err) {
          showAlert(err.message, "danger");
        }
      }
    );
    const readToggle = document.getElementById("read-toggle");
    readToggle.addEventListener("change", async () => {
      const isRead = readToggle.checked ? 1 : 0;
      const label = readToggle.nextElementSibling;
      label.textContent = isRead ? "Read" : "Unread";
      try {
        const updates = { is_read: isRead };
        if (isRead && !book.date_finished) {
          const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
          updates.date_finished = today;
          document.getElementById("date-finished").value = today;
        }
        await api.updateBook(username2, book.id, updates);
        showAlert("Status updated", "success");
      } catch (err) {
        showAlert(err.message, "danger");
      }
    });
    const dateFinished = document.getElementById("date-finished");
    dateFinished.addEventListener("change", async () => {
      try {
        await api.updateBook(username2, book.id, {
          date_finished: dateFinished.value || null
        });
        showAlert("Date updated", "success");
      } catch (err) {
        showAlert(err.message, "danger");
      }
    });
    const downloadBtn = document.getElementById("download-btn");
    if (downloadBtn) {
      downloadBtn.addEventListener("click", async () => {
        downloadBtn.setAttribute("disabled", "true");
        downloadBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Downloading...';
        try {
          await api.downloadFile(username2, book.id, book.title);
        } catch (err) {
          showAlert(err.message, "danger");
        } finally {
          downloadBtn.removeAttribute("disabled");
          downloadBtn.innerHTML = '<i class="bi bi-download"></i> Download EPUB';
        }
      });
    }
    const kindleBtn = document.getElementById("kindle-btn");
    if (kindleBtn) {
      kindleBtn.addEventListener("click", async () => {
        kindleBtn.setAttribute("disabled", "true");
        kindleBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Sending...';
        try {
          const result = await api.sendToKindle(username2, book.id);
          showAlert(`Sent to ${result.sent_to}`, "success");
        } catch (err) {
          showAlert(err.message, "danger");
        } finally {
          kindleBtn.removeAttribute("disabled");
          kindleBtn.innerHTML = '<i class="bi bi-send"></i> Send to Kindle';
        }
      });
    }
    const deleteBtn = document.getElementById("delete-btn");
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Delete "${book.title}"? This cannot be undone.`)) return;
      try {
        await api.deleteBook(username2, book.id);
        navigateHome();
      } catch (err) {
        showAlert(err.message, "danger");
      }
    });
  }
  function showAlert(message, type) {
    const container = document.getElementById("action-alert");
    container.innerHTML = `
        <div class="alert alert-${type} alert-dismissible fade show py-2" role="alert">
            ${escapeHtml2(message)}
            <button type="button" class="btn-close btn-sm" data-bs-dismiss="alert"></button>
        </div>
    `;
    setTimeout(() => {
      container.innerHTML = "";
    }, 3e3);
  }
  function formatDate(dateStr) {
    if (!dateStr) return "-";
    try {
      return new Date(dateStr).toLocaleDateString();
    } catch {
      return dateStr;
    }
  }
  function escapeHtml2(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // src/pages/series-list.ts
  async function renderSeriesList() {
    const app = document.getElementById("app");
    const username2 = getLibraryUsername();
    app.innerHTML = `
        <div class="loading-spinner">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
        </div>
    `;
    try {
      const data = await api.getSeries(username2);
      const series = data.series;
      if (series.length === 0) {
        app.innerHTML = `
                <div class="text-center text-muted py-5">
                    <i class="bi bi-collection" style="font-size: 3rem;"></i>
                    <p class="mt-2">No series found</p>
                </div>
            `;
        return;
      }
      let html = `<h4 class="mb-3">${series.length} Series</h4>`;
      html += '<div class="row g-3">';
      for (const s of series) {
        const pct = s.total_books > 0 ? Math.round(s.read_count / s.total_books * 100) : 0;
        const avgRating = s.avg_rating ? s.avg_rating.toFixed(1) : "-";
        html += `
                <div class="col-12 col-sm-6 col-md-4 col-lg-3">
                    <div class="card series-card h-100" data-series="${escapeAttr2(s.series)}">
                        <div class="card-body">
                            <h6 class="card-title mb-1">${escapeHtml3(s.series)}</h6>
                            <div class="d-flex justify-content-between text-muted small mb-2">
                                <span>${s.total_books} book${s.total_books !== 1 ? "s" : ""}</span>
                                <span>${s.read_count}/${s.total_books} read</span>
                            </div>
                            <div class="progress series-progress mb-2">
                                <div class="progress-bar bg-success" style="width: ${pct}%"></div>
                            </div>
                            <div class="text-muted small">
                                Avg rating: ${avgRating}
                            </div>
                        </div>
                    </div>
                </div>
            `;
      }
      html += "</div>";
      app.innerHTML = html;
      app.querySelectorAll(".series-card").forEach((card) => {
        card.addEventListener("click", () => {
          const name = card.getAttribute("data-series");
          if (name) navigate(`#/series/${encodeURIComponent(name)}`);
        });
      });
    } catch (err) {
      app.innerHTML = `
            <div class="alert alert-danger">
                Failed to load series: ${err.message}
            </div>
        `;
    }
  }
  function escapeHtml3(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
  function escapeAttr2(text) {
    return text.replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  // src/pages/series-view.ts
  async function renderSeriesView(params) {
    const app = document.getElementById("app");
    const username2 = getLibraryUsername();
    const seriesName = params.name;
    app.innerHTML = `
        <div class="loading-spinner">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
        </div>
    `;
    try {
      const data = await api.getSeriesBooks(username2, seriesName);
      const books = data.books;
      const firstUnreadIdx = books.findIndex((b) => !b.is_read);
      let html = `
            <a href="#/series" class="btn btn-outline-secondary btn-sm mb-3">
                <i class="bi bi-arrow-left"></i> All Series
            </a>
            <h4 class="mb-3">${escapeHtml4(seriesName)}</h4>
            <div class="text-muted mb-3">
                ${books.length} book${books.length !== 1 ? "s" : ""}
                &middot; ${books.filter((b) => b.is_read).length} read
            </div>
        `;
      html += '<div class="list-group">';
      for (let i = 0; i < books.length; i++) {
        const book = books[i];
        const isNextUnread = i === firstUnreadIdx;
        const coverImg = book.cover_filename ? `<img src="${api.coverUrl(book.user_id, book.cover_filename)}"
                       style="width: 50px; height: 75px; object-fit: cover; border-radius: 4px;"
                       loading="lazy">` : `<div style="width: 50px; height: 75px; background: #e9ecef; border-radius: 4px;
                       display: flex; align-items: center; justify-content: center;">
                       <i class="bi bi-book text-muted"></i></div>`;
        html += `
                <a href="#/book/${book.id}"
                   class="list-group-item list-group-item-action d-flex align-items-center gap-3
                          ${isNextUnread ? "next-unread" : ""}">
                    ${coverImg}
                    <div class="flex-grow-1">
                        <div class="d-flex justify-content-between">
                            <div>
                                <span class="text-muted me-2">#${book.series_index || "?"}</span>
                                <strong>${escapeHtml4(book.title)}</strong>
                            </div>
                            <div>
                                ${book.is_read ? '<span class="badge bg-success">Read</span>' : isNextUnread ? '<span class="badge bg-primary">Next</span>' : '<span class="badge bg-secondary">Unread</span>'}
                            </div>
                        </div>
                        <div class="small text-muted">${escapeHtml4(book.authors)}</div>
                        ${book.rating ? `<div class="mt-1">${ratingStarsHtml(book.rating)}</div>` : ""}
                    </div>
                </a>
            `;
      }
      html += "</div>";
      app.innerHTML = html;
    } catch (err) {
      app.innerHTML = `
            <div class="alert alert-danger">
                Failed to load series: ${err.message}
            </div>
        `;
    }
  }
  function escapeHtml4(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // src/pages/add-book.ts
  function renderAddBook() {
    const app = document.getElementById("app");
    const username2 = getLibraryUsername();
    if (!isOwner()) {
      navigateHome();
      return;
    }
    app.innerHTML = `
        <div style="max-width: 700px; margin: 0 auto;">
            <h4 class="mb-3">Add Book</h4>

            <div class="card mb-3">
                <div class="card-body">
                    <h6>Upload EPUB</h6>
                    <div class="mb-3">
                        <input type="file" class="form-control" id="epub-file"
                               accept=".epub">
                    </div>
                    <button class="btn btn-outline-secondary btn-sm" id="extract-btn" disabled>
                        Extract Metadata
                    </button>
                </div>
            </div>

            <div class="card mb-3">
                <div class="card-body">
                    <h6>Metadata Search</h6>
                    <div class="input-group mb-3">
                        <input type="text" class="form-control" id="meta-query"
                               placeholder="Search by title, author, or ISBN...">
                        <button class="btn btn-outline-primary" id="meta-search-btn">
                            Search
                        </button>
                    </div>
                    <div id="meta-results"></div>
                </div>
            </div>

            <div class="card mb-3">
                <div class="card-body">
                    <h6>Book Details</h6>
                    <form id="add-form">
                        <div class="mb-2">
                            <label class="form-label">Title</label>
                            <input type="text" class="form-control" id="add-title" required>
                        </div>
                        <div class="mb-2">
                            <label class="form-label">Authors</label>
                            <input type="text" class="form-control" id="add-authors">
                        </div>
                        <div class="row mb-2">
                            <div class="col-8">
                                <label class="form-label">Series</label>
                                <input type="text" class="form-control" id="add-series">
                            </div>
                            <div class="col-4">
                                <label class="form-label">Series #</label>
                                <input type="number" class="form-control" id="add-series-index"
                                       step="0.1">
                            </div>
                        </div>
                        <div class="mb-2">
                            <label class="form-label">Description</label>
                            <textarea class="form-control" id="add-description" rows="3"></textarea>
                        </div>
                        <div id="add-error" class="alert alert-danger d-none"></div>
                        <button type="submit" class="btn btn-primary" id="add-submit">
                            Add Book
                        </button>
                    </form>
                </div>
            </div>
        </div>
    `;
    const fileInput = document.getElementById("epub-file");
    const extractBtn = document.getElementById("extract-btn");
    fileInput.addEventListener("change", () => {
      extractBtn.removeAttribute("disabled");
    });
    extractBtn.addEventListener("click", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      extractBtn.setAttribute("disabled", "true");
      extractBtn.textContent = "Extracting...";
      try {
        const formData = new FormData();
        formData.append("file", file);
        const token = getToken();
        const headers = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const resp = await fetch(`/api/${username2}/metadata/extract`, {
          method: "POST",
          headers,
          body: formData
        });
        if (!resp.ok) throw new Error("Extraction failed");
        const meta = await resp.json();
        fillForm(meta);
      } catch (err) {
        showError(err.message);
      } finally {
        extractBtn.removeAttribute("disabled");
        extractBtn.textContent = "Extract Metadata";
      }
    });
    document.getElementById("meta-search-btn").addEventListener("click", async () => {
      const query = document.getElementById("meta-query").value;
      if (!query) return;
      const resultsDiv = document.getElementById("meta-results");
      resultsDiv.innerHTML = '<div class="spinner-border spinner-border-sm"></div>';
      try {
        const data = await api.searchMetadata(username2, query);
        if (!data.results.length) {
          resultsDiv.innerHTML = '<p class="text-muted">No results found</p>';
          return;
        }
        resultsDiv.innerHTML = data.results.map((r, i) => `
                <div class="border rounded p-2 mb-2 meta-result" role="button"
                     data-index="${i}">
                    <strong>${escapeHtml5(r.title)}</strong>
                    <div class="small text-muted">${escapeHtml5(r.authors)}</div>
                    ${r.isbn ? `<div class="small">ISBN: ${r.isbn}</div>` : ""}
                </div>
            `).join("");
        resultsDiv.querySelectorAll(".meta-result").forEach((el) => {
          el.addEventListener("click", () => {
            const idx = parseInt(el.getAttribute("data-index"));
            fillForm(data.results[idx]);
          });
        });
      } catch (err) {
        resultsDiv.innerHTML = `<p class="text-danger">${err.message}</p>`;
      }
    });
    document.getElementById("add-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const file = fileInput.files?.[0];
      if (!file) {
        showError("Please select an EPUB file");
        return;
      }
      const submitBtn = document.getElementById("add-submit");
      submitBtn.setAttribute("disabled", "true");
      submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Adding...';
      try {
        const metadata = {};
        const title = document.getElementById("add-title").value;
        const authors = document.getElementById("add-authors").value;
        const series = document.getElementById("add-series").value;
        const seriesIndex = document.getElementById("add-series-index").value;
        if (title) metadata.title = title;
        if (authors) metadata.authors = authors;
        if (series) metadata.series = series;
        if (seriesIndex) metadata.series_index = parseFloat(seriesIndex);
        const book = await api.uploadBook(username2, file, metadata);
        navigate(`#/book/${book.id}`);
      } catch (err) {
        showError(err.message);
      } finally {
        submitBtn.removeAttribute("disabled");
        submitBtn.textContent = "Add Book";
      }
    });
  }
  function fillForm(meta) {
    if (meta.title) {
      document.getElementById("add-title").value = meta.title;
    }
    if (meta.authors) {
      document.getElementById("add-authors").value = meta.authors;
    }
    if (meta.description) {
      document.getElementById("add-description").value = meta.description.replace(/<[^>]*>/g, "");
    }
  }
  function showError(message) {
    const el = document.getElementById("add-error");
    el.textContent = message;
    el.classList.remove("d-none");
    setTimeout(() => el.classList.add("d-none"), 5e3);
  }
  function escapeHtml5(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // src/main.ts
  var username = getLibraryUsername();
  if (!username) {
    renderLogin();
    bootstrapAuth();
    updateNavbar();
  } else {
    setDefaultRoute(() => renderLibrary());
    addRoute("/book/:id", (p) => renderBookDetail(p));
    addRoute("/series", () => renderSeriesList());
    addRoute("/series/:name", (p) => renderSeriesView(p));
    addRoute("/add", () => renderAddBook());
    bootstrapAuth();
    updateNavbar();
    startRouter();
  }
})();
