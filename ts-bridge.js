// Перехватывает запросы Lampa к TorrServer и отправляет их через нативный канал AndroidJS
(function () {
  var REFERER = localStorage.ts_nb_referer || "http://127.0.0.1/";

  var SKIP_PATHS = ["/stream/", "/gst/", "/play/", "/subs", "/playlist"];
  var SKIP_METHODS = ["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT"];
  var SKIP_DATA_TYPES = ["script", "jsonp", "xml", "html", "blob", "arraybuffer"];

  var stats = (window.tsNB = { routed: 0, ok: 0, err: 0, lastError: "" });

  var proxy = null;

  function originOf(url) {
    try {
      return new URL(String(url), location.href).origin;
    } catch (e) {
      return "";
    }
  }

  function isTorrServerUrl(url) {
    var server = originOf(Lampa.Torserver.url() || "");
    if (!server || server === location.origin) return false;

    return originOf(url) === server;
  }

  // Версия AndroidJS ниже 16 не поддерживает нужные методы HTTP-моста
  function nativeBridgeAvailable() {
    try {
      if (typeof AndroidJS === "undefined" || !AndroidJS.httpReq) return false;

      var versionCode = String(AndroidJS.appVersion()).split("-").pop();
      return parseInt(versionCode, 10) >= 16;
    } catch (e) {
      return false;
    }
  }

  function skipRequest(settings, url, method) {
    if (settings.xhr || settings.xhrFields) return true;
    if (SKIP_DATA_TYPES.indexOf(String(settings.dataType || "").toLowerCase()) >= 0) return true;
    if (SKIP_METHODS.indexOf(method) >= 0) return true;

    return SKIP_PATHS.some(function (path) {
      return url.indexOf(path) >= 0;
    });
  }

  // Вызываем beforeSend на фейковом объекте чтобы вытащить Authorization токен,
  // который Lampa проставляет внутри этой функции
  function collectHeaders(settings) {
    var headers = {};

    if (typeof settings.beforeSend === "function") {
      try {
        settings.beforeSend(
          {
            setRequestHeader: function (name, value) {
              headers[name] = value;
            },
          },
          settings,
        );
      } catch (e) {}
    }

    // иначе APK подставил бы Referer = LAMPA_URL
    headers.Referer = REFERER;

    return headers;
  }

  function patchAjax() {
    var $ = window.jQuery || window.$;

    if (!$ || !$.ajax) return;
    if (!nativeBridgeAvailable()) return;

    // Свой экземпляр Request чтобы native() уводил запрос в android_go()
    proxy = new Lampa.Reguest();

    var originalAjax = $.ajax;

    $.ajax = function (settings) {
      settings = settings || {};

      var url = settings.url;
      var method = String(settings.type || settings.method || "").toUpperCase();

      if (!isTorrServerUrl(url) || skipRequest(settings, url, method)) {
        return originalAjax.apply($, arguments);
      }

      stats.routed++;

      var aborted = false;
      var data = settings.data;

      if (data != null && typeof data !== "string") data = JSON.stringify(data);

      // setTimeout(0) ОБЯЗАТЕЛЕН. Без него колбэки прилетают раньше,
      // чем Lampa доделает синхронную инициализацию, и все падает и пиздец
      setTimeout(function () {
        if (aborted) return;

        proxy.native(
          url,
          function (response) {
            if (aborted) return;

            stats.ok++;
            if (settings.success) settings.success(response, "success");
            if (settings.complete) settings.complete({ status: 200 }, "success");
          },
          function (error, exception) {
            if (aborted) return;

            stats.err++;
            stats.lastError = JSON.stringify(error || 0).slice(0, 200);

            // лепим jqXHR-подобный объект вручную, потому что Lampa ожидает именно этот интерфейс
            var jqXHR = { status: (error && error.status) || 0 };

            jqXHR.responseText = (error && (error.responseText || error.message)) || "native error";
            try {
              jqXHR.responseJSON = JSON.parse(jqXHR.responseText);
            } catch (e) {}

            if (settings.error) settings.error(jqXHR, exception || "error", jqXHR.responseText);
            if (settings.complete) settings.complete(jqXHR, "error");
          },
          data,
          {
            dataType: settings.dataType || "json",
            timeout: settings.timeout,
            headers: collectHeaders(settings),
          },
        );
      }, 0);

      return {
        abort: function () {
          aborted = true;
        },
      };
    };
  }

  var attempts = 0;

  // Ждём загрузки всех зависимостей максимум ~10 сек. Если не загрузилось патчим вслепую
  (function wait() {
    var ready =
      window.Lampa &&
      window.Lampa.Torserver &&
      window.Lampa.Reguest &&
      (window.jQuery || window.$) &&
      typeof AndroidJS !== "undefined";

    if (ready || ++attempts > 40) patchAjax();
    else setTimeout(wait, 250);
  })();
})();
