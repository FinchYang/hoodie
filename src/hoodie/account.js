/* exported hoodieAccount */

// Hoodie.Account
// ================

//
function hoodieAccount (hoodie) {

  // public API
  var account = {};

  //
  account.username = '';
  account.ownerHash = '';

  // flag wether user is currently authenticated or not
  // TODO: hide this from public API, replace with getter function
  //       and remove _
  account._authenticated = undefined;

  // cache for CouchDB _users doc
  // TODO: hidef from public API, rename to userDoc
  account._doc = {};

  // map of requestPromises. We maintain this list to avoid sending
  // the same requests several times.
  // TODO: hide this from public API and remove the _
  account._requests = {};

  // default couchDB user doc prefix
  var userDocPrefix = 'org.couchdb.user';


  // init
  // ------

  // we've put this into its own method so it's easier to
  // inherit from Hoodie.Account and add custom logic
  account.init = function init() {
    // handle session
    account.username = hoodie.config.get('_account.username');
    account.ownerHash = hoodie.config.get('_account.ownerHash');

    // he ownerHash gets stored in every object created by the user.
    // Make sure we have one.
    if (!account.ownerHash) {
      setOwner(hoodie.uuid());
    }

    // authenticate on next tick
    window.setTimeout(account.authenticate);

    // is there a pending password reset?
    // TODO: spec that
    checkPasswordResetStatus();
  };


  // Authenticate
  // --------------

  // Use this method to assure that the user is authenticated:
  // `hoodie.account.authenticate().done( doSomething ).fail( handleError )`
  //
  account.authenticate = function authenticate() {
    var sendAndHandleAuthRequest, _ref, _ref1;

    if (account._authenticated === false) {
      return hoodie.defer().reject().promise();
    }

    if (account._authenticated === true) {
      return hoodie.defer().resolve(account.username).promise();
    }

    // if there is a pending signOut request, return its promise,
    // but pipe it so that it always ends up rejected
    //
    if (((_ref = account._requests.signOut) !== undefined ? _ref.state() : null) === 'pending') {
      return account._requests.signOut.then(hoodie.rejectWith);
    }

    // if there is apending signIn request, return its promise
    if (((_ref1 = account._requests.signIn) !== undefined ? _ref1.state() : null) === 'pending') {
      return account._requests.signIn;
    }

    // if username is not set, make sure to end the session
    if (account.username === undefined) {
      return sendSignOutRequest().then(function() {
        account._authenticated = false;
        return hoodie.rejectWith();
      });
    }

    // send request to check for session status. If there is a
    // pending request already, return its promise.
    //
    sendAndHandleAuthRequest = function() {
      return account.request('GET', "/_session").pipe(
        handleAuthenticateRequestSuccess,
        handleRequestError
      );
    };

    return withSingleRequest('authenticate', sendAndHandleAuthRequest);
  };


  // sign up with username & password
  // ----------------------------------

  // uses standard CouchDB API to create a new document in _users db.
  // The backend will automatically create a userDB based on the username
  // address and approve the account by adding a "confirmed" role to the
  // user doc. The account confirmation might take a while, so we keep trying
  // to sign in with a 300ms timeout.
  //
  account.signUp = function signUp(username, password) {
    if (password === undefined) {
      password = '';
    }

    if (!username) {
      return hoodie.defer().reject({
        error: 'username must be set'
      }).promise();
    }

    if (account.hasAnonymousAccount()) {
      return upgradeAnonymousAccount(username, password);
    }

    if (account.hasAccount()) {
      return hoodie.defer().reject({
        error: 'you have to sign out first'
      }).promise();
    }

    // downcase username
    username = username.toLowerCase();

    var options = {
      data: JSON.stringify({
        _id: userDocKey(username),
        name: userTypeAndId(username),
        type: 'user',
        roles: [],
        password: password,
        ownerHash: account.ownerHash,
        database: account.db(),
        updatedAt: account._now(),
        createdAt: account._now(),
        signedUpAt: username !== account.ownerHash ? account._now() : void 0
      }),
      contentType: 'application/json'
    };

    return account.request('PUT', userDocUrl(username), options).pipe(
      _handleSignUpSucces(username, password),
      handleRequestError
    );
  };


  // anonymous sign up
  // -------------------

  // If the user did not sign up himself yet, but data needs to be transfered
  // to the couch, e.g. to send an email or to share data, the anonymousSignUp
  // method can be used. It generates a random password and stores it locally
  // in the browser.
  //
  // If the user signes up for real later, we "upgrade" his account, meaning we
  // change his username and password internally instead of creating another user.
  //
  account.anonymousSignUp = function anonymousSignUp() {
    var password, username;

    password = hoodie.uuid(10);
    username = account.ownerHash;

    return account.signUp(username, password).done(function() {
      setAnonymousPassword(password);
      return account.trigger('signup:anonymous', username);
    });
  };


  // hasAccount
  // ---------------------

  //
  account.hasAccount = function hasAccount() {
    return !!account.username;
  };


  // hasAnonymousAccount
  // ---------------------

  //
  account.hasAnonymousAccount = function hasAnonymousAccount() {
    return account.getAnonymousPassword() !== undefined;
  };


  // set / get / remove anonymous password
  // ---------------------------------------

  //
  var anonymousPasswordKey = '_account.anonymousPassword';

  function setAnonymousPassword(password) {
    return hoodie.config.set(anonymousPasswordKey, password);
  }

  // TODO: hide from public API
  account.getAnonymousPassword = function getAnonymousPassword() {
    return hoodie.config.get(anonymousPasswordKey);
  };

  function removeAnonymousPassword() {
    return hoodie.config.remove(anonymousPasswordKey);
  }


  // sign in with username & password
  // ----------------------------------

  // uses standard CouchDB API to create a new user session (POST /_session).
  // Besides the standard sign in we also check if the account has been confirmed
  // (roles include "confirmed" role).
  //
  // NOTE: When signing in, all local data gets cleared beforehand (with a signOut).
  //       Otherwise data that has been created beforehand (authenticated with
  //       another user account or anonymously) would be merged into the user
  //       account that signs in. That applies only if username isn't the same as
  //       current username.
  //
  account.signIn = function signIn(username, password) {

    if (username === null) {
      username = '';
    }

    if (password === undefined) {
      password = '';
    }

    // downcase
    username = username.toLowerCase();

    if (username !== account.username) {
      return account.signOut({
        silent: true
      }).pipe(function() {
        return account._sendSignInRequest(username, password);
      });
    } else {
      return account._sendSignInRequest(username, password, {
        reauthenticated: true
      });
    }
  };


  // sign out
  // ---------

  // uses standard CouchDB API to invalidate a user session (DELETE /_session)
  //
  account.signOut = function signOut(options) {

    options = options || {};

    if (!account.hasAccount()) {
      return cleanup().then(function() {
        if (!options.silent) {
          return account.trigger('signout');
        }
      });
    }
    hoodie.remote.disconnect();
    return sendSignOutRequest().pipe(cleanupAndTriggerSignOut);
  };


  // On
  // ---

  // shortcut for `hoodie.on`
  //
  account.on = function on(eventName, cb) {
    eventName = eventName.replace(/(^| )([^ ]+)/g, "$1account:$2");
    return hoodie.on(eventName, cb);
  };


  // Trigger
  // ---

  // shortcut for `hoodie.trigger`
  //
  account.trigger = function trigger() {
    var eventName, parameters;

    eventName = arguments[0],
    parameters = 2 <= arguments.length ? Array.prototype.slice.call(arguments, 1) : [];

    hoodie.trigger.apply(hoodie, ["account:" + eventName].concat(Array.prototype.slice.call(parameters)));
  };


  // Request
  // ---

  // shortcut for `hoodie.request`
  //
  account.request = function request(type, path, options) {
    options = options || {};
    return hoodie.request.apply(hoodie, arguments);
  };


  // db
  // ----

  // return name of db
  //
  account.db = function db() {
    return "user/" + account.ownerHash;
  };


  // fetch
  // -------

  // fetches _users doc from CouchDB and caches it in _doc
  //
  account.fetch = function fetch(username) {

    if (username === undefined) {
      username = account.username;
    }

    if (!username) {
      return hoodie.defer().reject({
        error: "unauthenticated",
        reason: "not logged in"
      }).promise();
    }

    return withSingleRequest('fetch', function() {
      return account.request('GET', userDocUrl(username)).pipe(
        null,
        handleRequestError
      ).done(function(response) {
        account._doc = response;
        return account._doc;
      });
    });
  };


  // change password
  // -----------------

  // Note: the hoodie API requires the currentPassword for security reasons,
  // but couchDb doesn't require it for a password change, so it's ignored
  // in this implementation of the hoodie API.
  //
  account.changePassword = function changePassword(currentPassword, newPassword) {

    if (!account.username) {
      return hoodie.defer().reject({
        error: "unauthenticated",
        reason: "not logged in"
      }).promise();
    }

    hoodie.remote.disconnect();

    return account.fetch().pipe(
      sendChangeUsernameAndPasswordRequest(currentPassword, null, newPassword),
      handleRequestError
    );
  };


  // reset password
  // ----------------

  // This is kind of a hack. We need to create an object anonymously
  // that is not exposed to others. The only CouchDB API othering such
  // functionality is the _users database.
  //
  // So we actualy sign up a new couchDB user with some special attributes.
  // It will be picked up by the password reset worker and removeed
  // once the password was resetted.
  //
  account.resetPassword = function resetPassword(username) {
    var data, key, options, resetPasswordId;
    resetPasswordId = hoodie.config.get('_account.resetPasswordId');

    if (resetPasswordId) {
      return checkPasswordResetStatus();
    }

    resetPasswordId = "" + username + "/" + (hoodie.uuid());

    hoodie.config.set('_account.resetPasswordId', resetPasswordId);

    key = "" + userDocPrefix + ":$passwordReset/" + resetPasswordId;

    data = {
      _id: key,
      name: "$passwordReset/" + resetPasswordId,
      type: 'user',
      roles: [],
      password: resetPasswordId,
      createdAt: account._now(),
      updatedAt: account._now()
    };

    options = {
      data: JSON.stringify(data),
      contentType: "application/json"
    };

    // TODO: spec that checkPasswordResetStatus gets executed
    return withPreviousRequestsAborted('resetPassword', function() {
      return account.request('PUT', "/_users/" + (encodeURIComponent(key)), options).pipe(
        null, handleRequestError
      ).done(checkPasswordResetStatus);
    });
  };


  // change username
  // -----------------

  // Note: the hoodie API requires the current password for security reasons,
  // but technically we cannot (yet) prevent the user to change the username
  // without knowing the current password, so it's not impulemented in the current
  // implementation of the hoodie API.
  //
  // But the current password is needed to login with the new username.
  //
  account.changeUsername = function changeUsername(currentPassword, newUsername) {
    newUsername = newUsername || '';
    return changeUsernameAndPassword(currentPassword, newUsername.toLowerCase());
  };


  // destroy
  // ---------

  // destroys a user's account
  //
  account.destroy = function destroy() {
    if (!account.hasAccount()) {
      return cleanupAndTriggerSignOut();
    }

    return account.fetch().pipe(
      handleFetchBeforeDestroySucces,
      handleFetchBeforeDestroyError
    ).pipe(cleanupAndTriggerSignOut);
  };


  // PRIVATE
  // ---------

  // setters
  function setUsername(newUsername) {
    if (account.username === newUsername) {
      return;
    }

    account.username = newUsername;

    return hoodie.config.set('_account.username', newUsername);
  }

  function setOwner(newOwnerHash) {

    if (account.ownerHash === newOwnerHash) {
      return;
    }

    account.ownerHash = newOwnerHash;

    // `ownerHash` is stored with every new object in the createdBy
    // attribute. It does not get changed once it's set. That's why
    // we have to force it to be change for the `$config/hoodie` object.
    hoodie.config.set('createdBy', newOwnerHash);

    return hoodie.config.set('_account.ownerHash', newOwnerHash);
  }


  //
  // handle a successful authentication request.
  //
  // As long as there is no server error or internet connection issue,
  // the authenticate request (GET /_session) does always return
  // a 200 status. To differentiate whether the user is signed in or
  // not, we check `userCtx.name` in the response. If the user is not
  // signed in, it's null, otherwise the name the user signed in with
  //
  // If the user is not signed in, we difeerentiate between users that
  // signed in with a username / password or anonymously. For anonymous
  // users, the password is stored in local store, so we don't need
  // to trigger an 'unauthenticated' error, but instead try to sign in.
  //
  function handleAuthenticateRequestSuccess(response) {
    if (response.userCtx.name) {
      account._authenticated = true;
      setUsername(response.userCtx.name.replace(/^user(_anonymous)?\//, ''));
      setOwner(response.userCtx.roles[0]);
      return hoodie.defer().resolve(account.username).promise();
    }

    if (account.hasAnonymousAccount()) {
      account.signIn(account.username, account.getAnonymousPassword());
      return;
    }

    account._authenticated = false;
    account.trigger('error:unauthenticated');
    return hoodie.defer().reject().promise();
  }


  //
  // standard error handling for AJAX requests
  //
  // in some case we get the object error directly,
  // in others we get an xhr or even just a string back
  // when the couch died entirely. Whe have to handle
  // each case
  //
  function handleRequestError(error) {
    var e;

    error = error || {};

    if (error.reason) {
      return hoodie.defer().reject(error).promise();
    }

    var xhr = error;

    try {
      error = JSON.parse(xhr.responseText);
    } catch (_error) {
      e = _error;
      error = {
        error: xhr.responseText || "unknown"
      };
    }

    return hoodie.defer().reject(error).promise();
  }


  //
  // handle response of a successful signUp request.
  // Response looks like:
  //
  //     {
  //         "ok": true,
  //         "id": "org.couchdb.user:joe",
  //         "rev": "1-e8747d9ae9776706da92810b1baa4248"
  //     }
  //
  function _handleSignUpSucces(username, password) {

    return function(response) {
      account.trigger('signup', username);
      account._doc._rev = response.rev;
      return delayedSignIn(username, password);
    };
  }


  //
  // a delayed sign in is used after sign up and after a
  // username change.
  //
  function delayedSignIn(username, password, options, defer) {

    // delayedSignIn might call itself, when the user account
    // is pending. In this case it passes the original defer,
    // to keep a reference and finally resolve / reject it
    // at some point
    if (!defer) {
      defer = hoodie.defer();
    }

    window.setTimeout(function() {
      var promise = account._sendSignInRequest(username, password);
      promise.done(defer.resolve);
      promise.fail(function(error) {
        if (error.error === 'unconfirmed') {

          // It might take a bit until the account has been confirmed
          delayedSignIn(username, password, options, defer);
        } else {
          defer.reject.apply(defer, arguments);
        }
      });

    }, 300);

    return defer.promise();
  }


  //
  // parse a successful sign in response from couchDB.
  // Response looks like:
  //
  //     {
  //         "ok": true,
  //         "name": "test1",
  //         "roles": [
  //             "mvu85hy",
  //             "confirmed"
  //         ]
  //     }
  //
  // we want to turn it into "test1", "mvu85hy" or reject the promise
  // in case an error occured ("roles" array contains "error")
  //
  function _handleSignInSuccess(options) {
    options = options || {};

    return function(response) {
      var defer, username;

      defer = hoodie.defer();
      username = response.name.replace(/^user(_anonymous)?\//, '');

      //
      // if an error occured, the userDB worker stores it to the $error attribute
      // and adds the "error" role to the users doc object. If the user has the
      // "error" role, we need to fetch his _users doc to find out what the error
      // is, before we can reject the promise.
      //
      if (response.roles.indexOf("error") !== -1) {
        account.fetch(username).fail(defer.reject).done(function() {
          return defer.reject({
            error: "error",
            reason: account._doc.$error
          });
        });
        return defer.promise();
      }

      //
      // When the userDB worker created the database for the user and everthing
      // worked out, it adds the role "confirmed" to the user. If the role is
      // not present yet, it might be that the worker didn't pick up the the
      // user doc yet, or there was an error. In this cases, we reject the promise
      // with an "uncofirmed error"
      //
      if (response.roles.indexOf("confirmed") === -1) {
        return defer.reject({
          error: "unconfirmed",
          reason: "account has not been confirmed yet"
        });
      }

      setUsername(username);
      setOwner(response.roles[0]);
      account._authenticated = true;

      //
      // options.verbose is true, when a user manually signed via hoodie.account.signIn().
      // We need to differentiate to other signIn requests, for example right after
      // the signup or after a session timed out.
      //
      if (!(options.silent || options.reauthenticated)) {
        if (account.hasAnonymousAccount()) {
          account.trigger('signin:anonymous', username);
        } else {
          account.trigger('signin', username);
        }
      }

      // user reauthenticated, meaning
      if (options.reauthenticated) {
        account.trigger('reauthenticated', username);
      }

      account.fetch();
      return defer.resolve(username, response.roles[0]);
    };
  }


  //
  // check for the status of a password reset. It might take
  // a while until the password reset worker picks up the job
  // and updates it
  //
  // If a password reset request was successful, the $passwordRequest
  // doc gets removed from _users by the worker, therefore a 401 is
  // what we are waiting for.
  //
  // Once called, it continues to request the status update with a
  // one second timeout.
  //
  function checkPasswordResetStatus() {
    var hash, options, resetPasswordId, url, username;

    // reject if there is no pending password reset request
    resetPasswordId = hoodie.config.get('_account.resetPasswordId');

    if (!resetPasswordId) {
      return hoodie.defer().reject({
        error: "missing"
      }).promise();
    }

    // send request to check status of password reset
    username = "$passwordReset/" + resetPasswordId;
    url = "/_users/" + (encodeURIComponent("" + userDocPrefix + ":" + username));
    hash = btoa("" + username + ":" + resetPasswordId);

    options = {
      headers: {
        Authorization: "Basic " + hash
      }
    };

    return withPreviousRequestsAborted('passwordResetStatus', function() {
      return account.request('GET', url, options).pipe(
        _handlePasswordResetStatusRequestSuccess,
        _handlePasswordResetStatusRequestError
      ).fail(function(error) {
        if (error.error === 'pending') {
          window.setTimeout(checkPasswordResetStatus, 1000);
          return;
        }
        return account.trigger('password_reset:error');
      });
    });
  }


  //
  // If the request was successful there might have occured an
  // error, which the worker stored in the special $error attribute.
  // If that happens, we return a rejected promise with the $error,
  // error. Otherwise reject the promise with a 'pending' error,
  // as we are not waiting for a success full response, but a 401
  // error, indicating that our password was changed and our
  // current session has been invalidated
  //
  function _handlePasswordResetStatusRequestSuccess(response) {
    var defer = hoodie.defer();

    if (response.$error) {
      defer.reject(response.$error);
    } else {
      defer.reject({
        error: 'pending'
      });
    }
    return defer.promise();
  }


  //
  // If the error is a 401, it's exactly what we've been waiting for.
  // In this case we resolve the promise.
  //
  function _handlePasswordResetStatusRequestError(xhr) {
    if (xhr.status === 401) {
      hoodie.config.remove('_account.resetPasswordId');
      account.trigger('passwordreset');

      return hoodie.defer().resolve();
    } else {
      return handleRequestError(xhr);
    }
  }


  //
  // change username and password in 3 steps
  //
  // 1. assure we have a valid session
  // 2. update _users doc with new username and new password (if provided)
  // 3. sign in with new credentials to create new sesion.
  //
  function changeUsernameAndPassword(currentPassword, newUsername, newPassword) {

    return account._sendSignInRequest(account.username, currentPassword, {
      silent: true
    }).pipe(function() {
      return account.fetch().pipe(
        sendChangeUsernameAndPasswordRequest(currentPassword, newUsername, newPassword)
      );
    });
  }


  //
  // turn an anonymous account into a real account
  //
  function upgradeAnonymousAccount(username, password) {
    var currentPassword;
    currentPassword = account.getAnonymousPassword();

    return changeUsernameAndPassword(currentPassword, username, password).done(function() {
      account.trigger('signup', username);
      removeAnonymousPassword();
    });
  }


  //
  // we now can be sure that we fetched the latest _users doc, so we can update it
  // without a potential conflict error.
  //
  function handleFetchBeforeDestroySucces() {

    hoodie.remote.disconnect();
    account._doc._deleted = true;

    return withPreviousRequestsAborted('updateUsersDoc', function() {
      account.request('PUT', userDocUrl(), {
        data: JSON.stringify(account._doc),
        contentType: 'application/json'
      });
    });
  }


  //
  // dependend on what kind of error we get, we want to ignore
  // it or not.
  // When we get a "not_found" it means that the _users doc habe
  // been removed already, so we don't need to do it anymore, but
  // still want to finish the destroy locally, so we return a
  // resolved promise
  //
  function handleFetchBeforeDestroyError(error) {
    if (error.error === 'not_found') {
      return hoodie.defer().resolve().promise();
    } else {
      return hoodie.defer().reject(error).promise();
    }
  }

  //
  // remove everything form the current account, so a new account can be initiated.
  //
  function cleanup(options) {
    options = options || {};

    // hoodie.store is listening on this one
    account.trigger('cleanup');
    account._authenticated = options.authenticated;
    hoodie.config.clear();
    setUsername(options.username);
    setOwner(options.ownerHash || hoodie.uuid());

    return hoodie.defer().resolve().promise();
  }


  //
  function cleanupAndTriggerSignOut() {
    return cleanup().then(function() {
      return account.trigger('signout');
    });
  }


  //
  // depending on wether the user signedUp manually or has been signed up
  // anonymously the prefix in the CouchDB _users doc differentiates.
  // An anonymous user is characterized by its username, that equals
  // its ownerHash (see `anonymousSignUp`)
  //
  // We differentiate with `hasAnonymousAccount()`, because `userTypeAndId`
  // is used within `signUp` method, so we need to be able to differentiate
  // between anonyomus and normal users before an account has been created.
  //
  function userTypeAndId(username) {
    var type;

    if (username === account.ownerHash) {
      type = 'user_anonymous';
    } else {
      type = 'user';
    }
    return "" + type + "/" + username;
  }


  //
  // turn a username into a valid _users doc._id
  //
  function userDocKey(username) {
    username = username || account.username;
    return "" + userDocPrefix + ":" + (userTypeAndId(username));
  }

  //
  // get URL of my _users doc
  //
  function userDocUrl(username) {
    return "/_users/" + (encodeURIComponent(userDocKey(username)));
  }


  //
  // update my _users doc.
  //
  // If a new username has been passed, we set the special attribut $newUsername.
  // This will let the username change worker create create a new _users doc for
  // the new username and remove the current one
  //
  // If a new password has been passed, salt and password_sha get removed
  // from _users doc and add the password in clear text. CouchDB will replace it with
  // according password_sha and a new salt server side
  //
  function sendChangeUsernameAndPasswordRequest(currentPassword, newUsername, newPassword) {

    return function() {
      // prepare updated _users doc
      var data = $.extend({}, account._doc);

      if (newUsername) {
        data.$newUsername = newUsername;
      }

      data.updatedAt = account._now();
      data.signedUpAt = data.signedUpAt || account._now();

      // trigger password update when newPassword set
      if (newPassword !== null) {
        delete data.salt;
        delete data.password_sha;
        data.password = newPassword;
      }

      var options = {
        data: JSON.stringify(data),
        contentType: 'application/json'
      };

      return withPreviousRequestsAborted('updateUsersDoc', function() {
        return account.request('PUT', userDocUrl(), options).pipe(
          _handleChangeUsernameAndPasswordRequest(newUsername, newPassword || currentPassword),
          handleRequestError
        );
      });

    };
  }


  //
  // depending on whether a newUsername has been passed, we can sign in right away
  // or have to use the delayed sign in to give the username change worker some time
  //
  function _handleChangeUsernameAndPasswordRequest(newUsername, newPassword) {

    return function() {
      hoodie.remote.disconnect();
      if (newUsername) {
        return delayedSignIn(newUsername, newPassword, {
          silent: true
        });
      } else {
        return account.signIn(account.username, newPassword);
      }
    };
  }


  //
  // make sure that the same request doesn't get sent twice
  // by cancelling the previous one.
  //
  function withPreviousRequestsAborted(name, requestFunction) {
    if (account._requests[name] !== undefined) {
      if (typeof account._requests[name].abort === "function") {
        account._requests[name].abort();
      }
    }
    account._requests[name] = requestFunction();
    return account._requests[name];
  }


  //
  // if there is a pending request, return its promise instead
  // of sending another request
  //
  function withSingleRequest(name, requestFunction) {

    if (account._requests[name] !== undefined) {
      if (typeof account._requests[name].state === "function") {
        if (account._requests[name].state() === 'pending') {
          return account._requests[name];
        }
      }
    }

    account._requests[name] = requestFunction();
    return account._requests[name];
  }


  //
  function sendSignOutRequest() {
    return withSingleRequest('signOut', function() {
      return account.request('DELETE', '/_session').pipe(null, handleRequestError);
    });
  }


  //
  // the sign in request that starts a CouchDB session if
  // it succeeds. We separated the actual sign in request from
  // the signIn method, as the latter also runs signOut intenrtally
  // to clean up local data before starting a new session. But as
  // other methods like signUp or changePassword do also need to
  // sign in the user (again), these need to send the sign in
  // request but without a signOut beforehand, as the user remains
  // the same.
  //

  // TODO: hide from public API & remove _
  account._sendSignInRequest = function sendSignInRequest(username, password, options) {
    var requestOptions = {
      data: {
        name: userTypeAndId(username),
        password: password
      }
    };

    return withPreviousRequestsAborted('signIn', function() {
      var promise = account.request('POST', '/_session', requestOptions);

      return promise.pipe(
        _handleSignInSuccess(options),
        handleRequestError
      );
    });

  };


  //
  // TODO: hide from public API, remove _
  account._now = function now() {
    return new Date();
  };




  //
  // PUBLIC API
  //
  hoodie.account = account;

  // init account
  account.init();
}
