"""Grab's mandatory, process-local network boundary. No network or files at import.

The explicit --use-postprocessor option makes a missing/import-failed plugin fatal
before extraction starts. Only the packaged plugin directory is searched.
"""
import copy
import http.cookiejar
import hashlib
import hmac
import json
import os
import urllib.parse
import urllib.request

from yt_dlp.postprocessor.common import PostProcessor
from yt_dlp.utils import DownloadError, PostProcessingError


def _origin(value):
    try:
        url = urllib.parse.urlsplit(value)
        if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password:
            return None
        port = url.port
        host = url.hostname.lower()
        if ':' in host:
            host = '[' + host + ']'
        if port and port != {'http': 80, 'https': 443}[url.scheme]:
            host += ':' + str(port)
        return url.scheme + '://' + host
    except (ValueError, TypeError):
        return None


def _harden_jar(jar):
    if getattr(jar, '_grab_strict', False):
        return
    policy = copy.copy(jar._policy)
    policy.strict_ns_domain |= http.cookiejar.DefaultCookiePolicy.DomainStrictNonDomain
    jar.set_policy(policy)
    original_set = jar.set_cookie

    def set_cookie(cookie):
        # yt-dlp's info-JSON serializer writes Domain even for host-only cookies.
        # Loading that representation must not widen an existing exact-host cookie.
        previous = jar._cookies.get(cookie.domain, {}).get(cookie.path, {}).get(cookie.name)
        if previous is not None and not previous.domain_specified:
            cookie = copy.copy(cookie)
            cookie.domain_specified = False
            cookie.domain_initial_dot = False
        original_set(cookie)

    jar.set_cookie = set_cookie
    jar._grab_strict = True


class _ScopeHeaders(urllib.request.BaseHandler):
    handler_order = 499

    def __init__(self, allowed_origins, authorization_origins):
        self.allowed_origins = allowed_origins
        self.authorization_origins = authorization_origins

    def http_request(self, request):
        target = _origin(request.full_url)
        for headers in (request.headers, request.unredirected_hdrs):
            for key in list(headers):
                name = key.lower()
                value = headers[key]
                if name == 'referer':
                    source = _origin(value)
                    if not source or (source.startswith('https:') and target and target.startswith('http:')):
                        del headers[key]
                    elif target not in self.allowed_origins and target != source:
                        headers[key] = source + '/'
                    else:
                        parts = urllib.parse.urlsplit(value)
                        headers[key] = urllib.parse.urlunsplit(parts._replace(fragment=''))
                elif name == 'origin' and target not in self.allowed_origins and target != _origin(value):
                    del headers[key]
                elif name == 'authorization':
                    # Extractors can create API-specific credentials. Bind each to the
                    # first origin that uses it; globally supplied credentials start
                    # scoped to the media origins supplied by the application.
                    origins = self.authorization_origins.setdefault(value, {target})
                    if target not in origins:
                        del headers[key]
        return request

    https_request = http_request


class GrabPrivacyPP(PostProcessor):
    def __init__(self, downloader=None):
        super().__init__(downloader)
        if downloader is None:
            raise PostProcessingError('Grab privacy policy needs an active downloader')
        try:
            origins = json.loads(os.environ.get('GRAB_HEADER_ORIGINS', '[]'))
            if not isinstance(origins, list) or any(_origin(value) != value for value in origins):
                raise ValueError('invalid header origins')
            self.allowed_origins = frozenset(origins)
            self.authorization_origins = {}
            for name, value in downloader.params.get('http_headers', {}).items():
                if name.lower() == 'authorization' and value:
                    self.authorization_origins[value] = self.allowed_origins
            key = os.environ.get('GRAB_CONTEXT_KEY', '')
            if len(key) != 64:
                raise ValueError('private context key unavailable')
            self.context_key = bytes.fromhex(key)
            jar = downloader.cookiejar
            _harden_jar(jar)
            director = downloader._request_director
            handler = director.handlers.get('Urllib')
            if handler is None:
                raise ValueError('strict HTTP handler unavailable')
            # requests/curl can copy cookies into jars with a different policy.
            # Use the verified urllib path, including its redirect processor.
            for name in list(director.handlers):
                if name != 'Urllib':
                    director.handlers.pop(name).close()
            create_instance = handler._create_instance

            def create_strict_instance(*args, **kwargs):
                _harden_jar(kwargs['cookiejar'])
                opener = create_instance(*args, **kwargs)
                opener.add_handler(_ScopeHeaders(self.allowed_origins, self.authorization_origins))
                return opener

            handler._create_instance = create_strict_instance
            self._guard_redirect_auth()
            self._preserve_cookie_records(downloader)
            self._guard_external_downloaders()
        except Exception as error:
            raise PostProcessingError('Grab privacy policy could not be installed') from error

    def _preserve_cookie_records(self, downloader):
        sanitize = downloader.sanitize_info
        process = downloader.process_ie_result

        def signature(records):
            # --load-info-json removes null-valued dictionary keys before processing.
            def canonical(value):
                if isinstance(value, dict):
                    return {k: canonical(v) for k, v in value.items() if v is not None}
                if isinstance(value, list):
                    return [canonical(v) for v in value]
                return value
            return hmac.new(self.context_key, json.dumps(canonical(records), sort_keys=True).encode(), hashlib.sha256).hexdigest()

        def verify_records(info):
            records = info.get('grab_cookie_records')
            if records is not None:
                supplied = info.get('grab_cookie_signature', '')
                if not isinstance(supplied, str) or not hmac.compare_digest(supplied, signature(records)):
                    raise DownloadError('Private cookie context could not be authenticated')
            return records

        def sanitize_private(info, *args, **kwargs):
            result = sanitize(info, *args, **kwargs)
            if isinstance(result, dict):
                # Scope metadata must survive JSON round trips as well as the cookie value.
                # Grab strips this field from its disk cache and keeps it only in memory.
                records = verify_records(result)
                if records is None and downloader.cookiejar:
                    result['grab_cookie_records'] = [dict(
                        name=c.name, value=c.value, domain=c.domain, path=c.path,
                        domain_specified=c.domain_specified, domain_initial_dot=c.domain_initial_dot,
                        secure=c.secure, expires=c.expires, discard=c.discard,
                        rest={k: '' if v is None else v for k, v in c._rest.items()},
                    ) for c in downloader.cookiejar]
                    result['grab_cookie_signature'] = signature(result['grab_cookie_records'])
            return result

        def process_private(info, *args, **kwargs):
            records = verify_records(info) if isinstance(info, dict) else None
            if isinstance(info, dict):
                info.pop('grab_cookie_records', None)
                info.pop('grab_cookie_signature', None)
            if records is not None:
                if not isinstance(records, list) or len(records) > 10000:
                    raise DownloadError('Invalid private cookie context')
                for record in records:
                    cookie = http.cookiejar.Cookie(
                        version=0, port=None, port_specified=False, path_specified=True,
                        comment=None, comment_url=None, rfc2109=False, **{'expires': None, **record})
                    downloader.cookiejar.set_cookie(cookie)
            return process(info, *args, **kwargs)

        downloader.sanitize_info = sanitize_private
        downloader.process_ie_result = process_private

    @staticmethod
    def _guard_redirect_auth():
        from yt_dlp.networking._urllib import RedirectHandler as HTTPRedirectHandler
        if getattr(HTTPRedirectHandler, '_grab_guarded', False):
            return
        original = HTTPRedirectHandler.redirect_request

        def redirect(handler, request, fp, code, msg, headers, newurl):
            redirected = original(handler, request, fp, code, msg, headers, newurl)
            if redirected is not None and _origin(request.full_url) != _origin(newurl):
                for values in (redirected.headers, redirected.unredirected_hdrs):
                    for key in list(values):
                        if key.lower() in ('authorization', 'proxy-authorization'):
                            del values[key]
            return redirected

        HTTPRedirectHandler.redirect_request = redirect
        HTTPRedirectHandler._grab_guarded = True

    @staticmethod
    def _guard_external_downloaders():
        from yt_dlp.downloader.external import ExternalFD
        if getattr(ExternalFD, '_grab_guarded', False):
            return
        original = ExternalFD.real_download

        def guarded(fd, filename, info, *args, **kwargs):
            sensitive = any(key.lower() in ('cookie', 'authorization', 'referer', 'origin') and value
                            for key, value in info.get('http_headers', {}).items())
            if fd.ydl.cookiejar or sensitive:
                raise DownloadError('Grab cannot enforce session privacy in an external network downloader')
            return original(fd, filename, info, *args, **kwargs)

        ExternalFD.real_download = guarded
        ExternalFD._grab_guarded = True

    def run(self, info):
        return [], info
