var Q = require('q');
var async = require('async');
var url = require('url');
var cheerio = require('cheerio');
var fs = require('fs');


module.exports = {
    /*
     * Go through HTML to match CSS selectors
     * @param {Array} html Html to search through. This can be either an array
     *         of Strings (containing html code), an array of URIs to visit, or
     *         an array of paths to html files.
     * @param {String} cookie Cookie to use for login, on the form
     *         "sessionid=foo". Each uri in the html parameter will
     *         be visited both with and without the cookie.
     * @param {String} whitelist List of selectors to ignore.
     * @param {Array} selectors Array of CSS selectors
     * @param {Object} result Object on the form { used: { ".foo": 1 },
     *                                             duplicates: { ".bar": 0 } }
     */
    matchSelectors: function(pages, cookie, selectors, whitelist) {
        var result = { used: {}, ignored: {} };
        var deferred = Q.defer();
        var processed = [];
        var i, l;

        // Handle excludes (except subdomains, which will be handled during crawl)
        // Add to processed, so they won't be visited
        // TODO: Could this be simplified, i.e. by merging this code with the code
        // inside q? Also, are there any hidden pitfalls here where something may
        // be crawled even if it shouldn't?
        var excludedSubdomains = [];
        if (pages.exclude) {
            for (i=0, l=pages.exclude.length; i<l; i++) {
                var current = pages.exclude[i];
                if (current.indexOf("*") !== -1) {
                    var subdomain = current.substring(0, current.length - 1);
                    if (subdomain.indexOf("http") === 0) {
                        subdomain = url.parse(subdomain).pathname;
                    }
                    excludedSubdomains.push(subdomain);
                    continue;
                }

                processed.push(current.split("?")[0]);
                processed.push(current.split("?")[0] + ": logged in");
            }
        }

        var self = this;
        var queue = async.queue(function(item, queueCallback) {
            // If in processed, skip (may have been in excluded list)
            if (-1 < processed.indexOf(item.page.split("?")[0])) {
                queueCallback();
                return;
            }

            var page = item.page;
            var uri, host;
            if (0 === page.indexOf("http")) {
                console.log("Visiting URL: ", item.page.split("?")[0]);
                uri = page;
                host = url.parse(uri).host || "";
            }

            var visits = [];
            visits.push(self._getHtmlAsString(item, null, processed)); // regular visit
            if (cookie) {
                visits.push(self._getHtmlAsString(item, cookie, processed)); // logged in visit
            }

            Q.all(visits)
            .spread(function(regularResult, loggedInResult) {
                var context = {
                    selectors: selectors,
                    whitelist: whitelist,
                    processed: processed,
                    excludedSubdomains: excludedSubdomains,
                    result: result
                };

                var regularItem = {
                    page: regularResult,
                    followLinks: item.followLinks,
                    uri: uri
                };
                self._processHtmlString(regularItem, context, queue);

                if (loggedInResult) {
                    var loggedInItem = {
                        page: loggedInResult,
                        followLinks: item.followLinks,
                        uri: uri
                    };
                    self._processHtmlString(loggedInItem, context, queue);
                }
            }).fail(function(error) {
                console.log(error);
            }).done(queueCallback); // Passing queue callback, in case it needs to abort
        }, 8);

        queue.drain = function(err) { // TODO: Handle err
            if (err) {
                deferred.reject(new Error(err));
            } else {
                deferred.resolve(result);
            }
        };

        // Crawl to find all HTML links
        if (pages.crawl) {
            for (i=0, l=pages.crawl.length; i<l; i++) {
                queue.push({page: pages.crawl[i], followLinks: true});
            }
        }

        if (pages.include) {
            for (i=0, l=pages.include.length; i<l; i++) {
                queue.push({page: pages.include[i], followLinks: false});
            }
        }

        return deferred.promise;
    },

    // TODO: Rename. Add docstring. Clean up parameters.
    _processHtmlString: function(item, context, queue) {
        var html = item.page;
        var followLinks = item.followLinks;
        var uri = item.uri;

        var selectors = context.selectors;
        var whitelist = context.whitelist;
        var processed = context.processed;
        var result = context.result;
        var excludedSubdomains = context.excludedSubdomains;

        var document = cheerio.load(html);

// TODO: Move check for external links in here too?

        if (followLinks) { // look for links in document, add to queue
            var links = document("a");
            for (var i=0, l=links.length; i<l; i++) {
                var handleThis = true;

                var href = links[i].attribs.href.split("#")[0];
                if (!href || href.indexOf("?") === 0) {
                    continue;
                }

                // If under excluded domain, skip
                for (var j=0; j<excludedSubdomains.length; j++) {
                    var excluded = excludedSubdomains[j];
                    if (href.indexOf(excluded) === 0 ||
                        url.parse(href).pathname.indexOf(excluded) === 0) {

                        handleThis = false;
                        break;
                    }
                }

                if (handleThis) {
                    this._handleLink(links[i].attribs.href, processed, uri, followLinks, queue);
                }
            }
        }

        // Process current document
        return this._matchSelectorsInString(document, selectors, whitelist, result);
    },

    _handleLink: function(link, processed, uri, followLinks, queue) {
        var host = url.parse(uri).host;

        if (-1 === processed.indexOf(link.split("?")[0])) { // If not processed yet, process
            if (0 === link.indexOf(uri)) { // current domain
                queue.push({page: link, followLinks: followLinks});
            } else if (0 === link.indexOf("http")) {
                if (url.parse(link).host === host) {
                    queue.push({page: link, followLinks: followLinks});
                } else {
                    // Skip, another domain
                }
            } else {
                if (uri) {
                    link = url.resolve(uri, link);
                    queue.push({page: link, followLinks: followLinks});
                } else {
                    console.log("Could not resolve " + link);
                }
            }
        }
    },

    // TODO: Rename. Add docstring. Clean up parameters.
    _matchSelectorsInString: function(htmlString, selectors, whitelist, result) {
        // Loop through selectors
        for (var k=0, l=selectors.length; k<l; k++) {
            var selector = selectors[k];

            // If current selector is whitelisted, skip.
            if (whitelist && -1 < whitelist.indexOf(selector)) {
                continue;
            }
            if (-1 < selector.indexOf("@")) {
                result.ignored[selector] = 1;
                continue;
            }

            if (selector) {
                var oSelector = selector;

                // Add selector to index, if not already added
                if (undefined === result.used[oSelector]) {
                    result.used[oSelector] = 0;
                }

                // Remove pseudo part of selector
                selector = selector.split(":")[0];

                // Check if selector is used
                try {
                    if (htmlString(selector).length > 0) {
                        result.used[oSelector] =
                            result.used[oSelector]
                            + htmlString(selector).length;
                    }
                } catch (e) {
                    console.log("Problem with selector: "
                                + oSelector);
                }
            }
        }
        return;
    },

    // TODO: Add docstring. Clean up parameters.
    _getHtmlAsString: function(item, cookie, processed) {
        var deferred = Q.defer();
        var page = item.page;
        var data;

        if (!cookie) {
            if (-1 < processed.indexOf(page.split("?")[0])) {
                deferred.resolve(""); // TODO: Do better than this?
            } else {
                processed.push(page.split("?")[0]);
            }
        } else {
            if (-1 < processed.indexOf(page.split("?")[0]) + ": logged in") {
                deferred.resolve(""); // TODO: Do better than this?
            } else {
                processed.push(page.split("?")[0] + ": logged in");
            }
        }

        // Get page as raw html
        // If URI is given, fetch HTML
        //
        // Note: _handleLink will add domain to relative URLs when crawling,
        // so they won't be mistaken for strings.
        if (0 === page.indexOf("http")) { // From URI
            var uri = page;

            var headers = {};
            if (cookie) {
                headers = {
                    "Cookie": cookie,
                    "Referer": uri
                };
            }

            var options = { uri: uri,
                            headers: headers };

            require('request').get(options, function(error, res, data) {
                                       // TODO: Error checking, response status code, etc.
                                       deferred.resolve(data);
                                   });
        } else if (-1 === page.indexOf("<html>")) { // From file
            try {
                data = fs.readFileSync(page).toString();
            } catch (e) {
                console.log(e.message);
            }
            deferred.resolve(data);
        } else { // From string
            deferred.resolve(page);
        }

        return deferred.promise;
    }
};