require "sinatra/base"

class App < Sinatra::Base
  set :host_authorization, { permitted_hosts: [] }

  get "/" do
    "Hello from Sinatra on LevantDeploy"
  end

  get "/health" do
    content_type :json
    '{"ok":true}'
  end
end
