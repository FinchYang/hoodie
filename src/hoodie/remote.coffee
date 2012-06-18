#
# Connection / Socket to our couch
#
# Remote is using couchDB's `_changes` feed to listen to changes
# and `_bulk_docs` to push local changes
#

define 'hoodie/remote', ['hoodie/errors'], (ERROR) ->
  
  # 'use strict'
  
  class Remote
  
    # ## Constructor
    #
    constructor : (@hoodie) ->
      
      @hoodie.on 'account:signed_in',  @connect
      @hoodie.on 'account:signed_out', @disconnect
      
      @hoodie.account.authenticate().then @connect
      
      
    # ## Connect
    #
    # start pulling changes from the userDB
    connect : () =>
      
      return if @_connected
      @hoodie.on 'store:dirty:idle', @push_changes
      @pull_changes()
      @push_changes()
    
      
    # ## Disconnect
    #
    # stop pulling changes from the userDB
    disconnect : =>
      @_connected = false
      @_changes_request?.abort()
      
      @reset_seq()
      @hoodie.unbind 'store:dirty:idle', @push_changes


    # ## pull changes
    #
    # a.k.a. make a longpoll AJAX request to CouchDB's `_changes` feed.
    #
    pull_changes: =>
      @_connected = true
      
      @_changes_request = @hoodie.request 'GET', @_changes_path(),
        success:      @_changes_success
        error:        @_changes_error
      
      window.clearTimeout @_changes_request_timeout
      @_changes_request_timeout = window.setTimeout @_restart_changes_request, 25000 # 25 sec
      
      
    # ## Push changes
    #
    # Push objects to userDB using the `_bulk_docs` API.
    # If no objects passed, push all changed documents
    push_changes : (docs) =>
      
      docs = @hoodie.store.changed_docs() unless docs
      return @_promise().resolve([]) if docs.length is 0
        
      docs = for doc in docs
        @_parse_for_remote doc 
      
      @hoodie.request 'POST', "/#{encodeURIComponent @hoodie.account.db()}/_bulk_docs", 
        dataType:     'json'
        processData:  false
        contentType:  'application/json'
      
        data        : JSON.stringify(docs: docs)
        success     : @_handle_push_changes
      
      
    # ## Get / Set seq
    #
    # the `seq` number gets passed to couchDB's `_changes` feed.
    # 
    get_seq   :       -> @_seq or= @hoodie.config.get('_remote.seq') or 0
    set_seq   : (seq) -> @_seq   = @hoodie.config.set('_remote.seq', seq)
    reset_seq : -> 
      @hoodie.config.remove '_remote.seq'
      delete @_seq
    
    # ## On
    #
    # alias for `hoodie.on`
    on : (event, cb) -> @hoodie.on "remote:#{event}", cb
    
    
    # ## Private
    
    #
    # changes url
    #
    # long poll url with heartbeat = 10 seconds
    #
    _changes_path : ->
      since = @get_seq()
      "/#{encodeURIComponent @hoodie.account.db()}/_changes?include_docs=true&heartbeat=10000&feed=longpoll&since=#{since}"
    
    # request gets restarted automaticcally in @_changes_error
    _restart_changes_request: => @_changes_request?.abort()
      
    #
    # changes success handler 
    #
    # handle the incoming changes, then send the next request
    #
    _changes_success : (response) =>
      
      return unless @_connected
      @set_seq response.last_seq
      @_handle_pull_changes(response.results)
      do @pull_changes
      
    # 
    # changes error handler 
    #
    # when there is a change, trigger event, 
    # then check for another change
    #
    _changes_error : (xhr, error, resp) =>
      return unless @_connected
    
      switch xhr.status
    
        # This happens when users session got invalidated on server
        when 403
          @hoodie.trigger 'remote:error:unauthenticated'
          do @disconnect
        
        # the 404 comes, when the requested DB of the User has been removed. 
        # Should really not happen. 
        # 
        # BUT: it might also happen that the profileDB is not ready yet. 
        #      Therefore, we try it again in 3 seconds
        #
        # TODO: review / rethink that.
        when 404
          window.setTimeout @pull_changes, 3000
        
        # Please server, don't give us these. At least not persistently 
        when 500
          @hoodie.trigger 'remote:error:server'
          window.setTimeout @pull_changes, 3000
        
        # usually a 0, which stands for timeout or server not reachable.
        else
          if xhr.statusText is 'abort'
            # manual abort after 25sec. reload changes directly.
            do @pull_changes
          else    
              
            # oops. This might be caused by an unreachable server.
            # Or the server canceld it for what ever reason, e.g.
            # heroku kills the request after ~30s.
            # we'll try again after a 3s timeout
            window.setTimeout @pull_changes, 3000
  
    # map of valid couchDB doc attributes starting with an underscore
    _valid_special_attributes:
      '_id'      : 1
      '_rev'     : 1
      '_deleted' : 1
  
  
    # parse object for remote storage. All attributes starting with an 
    # `underscore` do not get synchronized despite the special attributes
    # `_id`, `_rev` and `_deleted`
    # 
    # Also `id` attribute gets renamed to `_id`
    #
    _parse_for_remote: (obj) ->
      attributes = $.extend {}, obj
    
      for attr of attributes
        continue if @_valid_special_attributes[attr]
        continue unless /^_/.test attr
        delete attributes[attr]
     
      attributes._id = "#{attributes.type}/#{attributes.id}"
      delete attributes.id
      
      return attributes
      
      
    # parse object for local storage. 
    # 
    # renames `_id` attribute to `id` and removes the type from the id,
    # e.g. `document/123` -> `123`
    _parse_from_remote: (obj) ->
      
      # handle id and type
      id = obj._id or obj.id
      delete obj._id
      [obj.type, obj.id] = id.split(/\//)
      
      # handle timestameps
      obj.created_at = new Date(Date.parse obj.created_at) if obj.created_at
      obj.updated_at = new Date(Date.parse obj.updated_at) if obj.updated_at
      
      # handle rev
      if obj.rev
        obj._rev = obj.rev
        delete obj.rev
      
      return obj
  
    #
    # handle changes from remote
    #
    # note: we don't trigger any events until all changes have been taken care of.
    #       Reason is, that on object could depend on a different object that has
    #       not been stored yet, but is within the same bulk of changes. This 
    #       is especially the case during initial bootstraps after a user logins.
    #
    _handle_pull_changes: (changes) =>
      _destroyed_docs = []
      _changed_docs   = []
      
      # 1. update or remove objects from local store
      for {doc} in changes
        doc = @_parse_from_remote(doc)
        if doc._deleted
          _destroyed_docs.push [doc, @hoodie.store.destroy(doc.type, doc.id, remote: true)]
        else
          _changed_docs.push   [doc, @hoodie.store.save(doc.type, doc.id, doc, remote: true)]
      
      # 2. trigger events
      for [doc, promise] in _destroyed_docs
        promise.then (object) => 
          @hoodie.trigger 'remote:destroyed', doc.type,   doc.id,    object
          @hoodie.trigger "remote:destroyed:#{doc.type}", doc.id,    object
          @hoodie.trigger "remote:destroyed:#{doc.type}:#{doc.id}",  object
          
          @hoodie.trigger 'remote:changed',                       'destroyed', doc.type, doc.id, object
          @hoodie.trigger "remote:changed:#{doc.type}",           'destroyed',            doc.id, object
          @hoodie.trigger "remote:changed:#{doc.type}:#{doc.id}", 'destroyed',                     object
      
      for [doc, promise] in _changed_docs
        promise.then (object, object_was_created) => 
          event = if object_was_created then 'created' else 'updated'
          @hoodie.trigger "remote:#{event}", doc.type,   doc.id,   object
          @hoodie.trigger "remote:#{event}:#{doc.type}", doc.id,   object
          @hoodie.trigger "remote:#{event}:#{doc.type}:#{doc.id}", object
        
          @hoodie.trigger "remote:changed",                       event, doc.type, doc.id, object
          @hoodie.trigger "remote:changed:#{doc.type}",           event,            doc.id, object
          @hoodie.trigger "remote:changed:#{doc.type}:#{doc.id}", event,                     object


    # Gets response to POST _bulk_docs request from couchDB.
    # Updates to documents (e.g. new _rev stamps) come through the _changes feed anyway
    # and do not need to handle it twice. 
    #
    # But what needs to be handled are conflicts.
    _handle_push_changes: (doc_responses) =>
      for response in doc_responses
        if response.error is 'conflict'
          @hoodie.trigger 'remote:error:conflict', response.id
        else
          doc     = @_parse_from_remote(response)
          update  = _rev: doc._rev 
          
          @hoodie.store.update(doc.type, doc.id, update, remote: true)
    
    #
    _promise: $.Deferred