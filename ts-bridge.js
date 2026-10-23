(function () {
  var REFERER_DEFAULT = "http://127.0.0.1/";

  var SKIP_METHODS = ["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT"];
  var SKIP_DATA_TYPES = ["script", "jsonp", "xml", "html", "blob", "arraybuffer"];

  var stats = (window.tsBridge = { routed: 0, ok: 0, err: 0, patched: false, lastError: "" });

  function enabled() {
    return Lampa.Storage.get("ts_bridge_enabled", true) !== false;
  }

  function referer() {
    return Lampa.Storage.get("ts_bridge_referer", REFERER_DEFAULT);
  }

  // "noapp" - не андроид-приложение Lampa
  // "old" - приложение старое, мост есть только с кода версии 16
  function bridgeState() {
    try {
      if (typeof AndroidJS === "undefined" || !AndroidJS.httpReq) return "noapp";

      var versionCode = String(AndroidJS.appVersion()).split("-").pop();
      if (parseInt(versionCode, 10) >= 16) return "ok";
    } catch (e) {}

    return "old";
  }

  function isTorrServerUrl(url) {
    var server = Lampa.Torserver.ip();

    return Boolean(server) && typeof url === "string" && url.indexOf(server) >= 0;
  }

  // Стримы жрёт <video>/hls.js мимо $.ajax. /gst/echo скипаем специально,
  // если ответит ок - Lampa перейдёт на gstreamer и получит 403
  function isMediaUrl(url) {
    return /[?&]play(?=&|$)/.test(url) || /\/(play|gst|download)\//.test(url);
  }

  function skipRequest(settings, url, method) {
    if (settings.xhr || settings.xhrFields) return true;
    if (SKIP_DATA_TYPES.indexOf(String(settings.dataType || "").toLowerCase()) >= 0) return true;
    if (SKIP_METHODS.indexOf(method) >= 0) return true;

    return isMediaUrl(url);
  }

  function collectHeaders(settings) {
    var headers = {};

    // beforeSend у Lampa задан всегда, и именно он проставляет Authorization для TorrServer
    if (typeof settings.beforeSend === "function") {
      try {
        settings.beforeSend(
          {
            setRequestHeader: function (n, v) {
              headers[n] = v;
            },
          },
          settings,
        );
      } catch (e) {}
    }

    // иначе APK подставил бы Referer = LAMPA_URL
    headers.Referer = referer();

    return headers;
  }

  function patchAjax() {
    var $ = window.jQuery || window.$;

    if (!$ || !$.ajax) return;
    if (bridgeState() !== "ok") return;

    var originalAjax = $.ajax;

    $.ajax = function (settings) {
      settings = settings || {};

      var url = settings.url;
      var method = String(settings.type || settings.method || "").toUpperCase();

      if (!enabled() || !isTorrServerUrl(url) || skipRequest(settings, url, method)) {
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

        // Свой экземпляр Request чтобы native() уводил запрос в android_go()
        var proxy = new Lampa.Reguest();

        proxy.native(
          url,
          function (response) {
            if (aborted) return;

            // На этом держится предзагрузка
            if ((settings.dataType || "json") === "json" && typeof response === "string") {
              return fail({ status: 200, responseText: response }, "parsererror");
            }

            stats.ok++;
            if (settings.success) settings.success(response, "success");
            if (settings.complete) settings.complete({ status: 200 }, "success");
          },
          fail,
          data,
          {
            dataType: settings.dataType || "json",
            timeout: settings.timeout,
            headers: collectHeaders(settings),
          },
        );

        // лепим jqXHR-подобный объект вручную, потому что Lampa ожидает именно этот интерфейс
        function fail(error, exception) {
          if (aborted) return;

          stats.err++;
          stats.lastError = JSON.stringify(error || 0).slice(0, 200);

          var jqXHR = { status: (error && error.status) || 0 };

          jqXHR.responseText = (error && (error.responseText || error.message)) || "native error";
          try {
            jqXHR.responseJSON = JSON.parse(jqXHR.responseText);
          } catch (e) {}

          if (settings.error) settings.error(jqXHR, exception || "error", jqXHR.responseText);
          if (settings.complete) settings.complete(jqXHR, "error");
        }
      }, 0);

      return {
        abort: function () {
          aborted = true;
        },
      };
    };

    stats.patched = true;
  }

  // Настройки и другое барахло
  function noty(text) {
    if (Lampa.Noty) Lampa.Noty.show(text, { time: 10000 });
  }

  function warnKey() {
    return bridgeState() === "old" ? "ts_bridge_need_update" : "ts_bridge_need_app";
  }

  function checkConnection() {
    var tr = Lampa.Lang.translate;
    var url = Lampa.Torserver.url();
    var $ = window.jQuery || window.$;

    if (!url) return noty(tr("ts_bridge_check_noserver"));
    if (!stats.patched || !enabled()) return noty(tr("ts_bridge_check_off"));

    var started = Date.now();

    $.ajax({
      url: url + "/echo",
      dataType: "text",
      timeout: 8000,
      success: function (version) {
        noty(tr("ts_bridge_check_ok") + ": TorrServer " + version + ", " + (Date.now() - started) + " ms");
      },
      error: function (xhr, exception) {
        noty(tr("ts_bridge_check_fail") + ": " + ((xhr && xhr.status) || "") + " " + (exception || ""));
      },
    });
  }

  function initUi() {
    if (!Lampa.Lang || !Lampa.SettingsApi) return;

    var tr = Lampa.Lang.translate;

    Lampa.Lang.add({
      ts_bridge_title: {
        ru: "TS Bridge",
      },
      ts_bridge_toggle: {
        ru: "Через TS Bridge",
        en: "Via TS Bridge",
      },
      ts_bridge_toggle_desc: {
        ru: "Альтернативный способ обращения к TorrServer. Используйте, если стандартный метод блокируется сервером.",
        en: "Alternative way to reach TorrServer. Use if the default method is blocked by the server.",
      },
      ts_bridge_referer: {
        ru: "Referer для замены",
        en: "Referer for replacement",
      },
      ts_bridge_referer_desc: {
        ru: "Подставляется в запросы к TorrServer вместо адреса страницы. Оставьте пустым, если всё работает.",
        en: "Sent with TorrServer requests instead of the page address. Leave empty if everything works.",
      },
      ts_bridge_check: {
        ru: "Проверить подключение",
        en: "Check connection",
      },
      ts_bridge_check_ok: {
        ru: "Работает",
        en: "Working",
      },
      ts_bridge_check_fail: {
        ru: "Не работает",
        en: "Failed",
      },
      ts_bridge_check_off: {
        ru: "Мост отключён в настройках",
        en: "Bridge is disabled in settings",
      },
      ts_bridge_check_noserver: {
        ru: "Не указан адрес TorrServer",
        en: "TorrServer address is not set",
      },
      ts_bridge_need_app: {
        ru: "Плагин работает только в Android-приложении Lampa. На webOS, Tizen, ПК и в браузере он недоступен.",
        en: "The plugin works only in the Lampa Android app. It is unavailable on webOS, Tizen, PC, and browsers.",
      },
      ts_bridge_need_update: {
        ru: "Плагин работает в Lampa начиная с версии 16. Обновите приложение.",
        en: "The plugin works in Lampa version 16 or higher. Please update the app.",
      },
    });

    // строка с предупреждением
    if (bridgeState() !== "ok") {
      Lampa.SettingsApi.addParam({
        component: "server",
        param: {
          name: "ts_bridge_warn",
          type: "static",
        },
        field: {
          name: tr(warnKey()),
        },
      });
    }

    Lampa.SettingsApi.addParam({
      component: "server",
      param: {
        name: "ts_bridge_head",
        type: "title",
      },
      field: {
        name: tr("ts_bridge_title"),
      },
    });

    Lampa.SettingsApi.addParam({
      component: "server",
      param: {
        name: "ts_bridge_enabled",
        type: "trigger",
        default: "true",
      },
      field: {
        name: tr("ts_bridge_toggle"),
        description: tr("ts_bridge_toggle_desc"),
      },
    });

    Lampa.SettingsApi.addParam({
      component: "server",
      param: {
        name: "ts_bridge_referer",
        type: "input",
        values: "",
        default: "",
        placeholder: REFERER_DEFAULT,
      },
      field: {
        name: tr("ts_bridge_referer"),
        description: tr("ts_bridge_referer_desc"),
      },
    });

    Lampa.SettingsApi.addParam({
      component: "server",
      param: {
        name: "ts_bridge_check",
        type: "button",
      },
      field: {
        name: tr("ts_bridge_check"),
      },
      onChange: checkConnection,
    });
  }

  function warnUnsupported() {
    if (bridgeState() === "ok" || !Lampa.Noty || !Lampa.Lang) return;

    setTimeout(function () {
      noty(Lampa.Lang.translate(warnKey()));
    }, 2000);
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

    if (ready || ++attempts > 40) {
      patchAjax();
      initUi();
      warnUnsupported();
    } else setTimeout(wait, 250);
  })();
})();
