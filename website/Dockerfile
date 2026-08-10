# RainCheck landing site — static HTML/CSS, served with nginx.
# No Node build step needed; this is pure static content.
FROM nginx:alpine

# Copy the site into nginx's default static-root.
COPY . /usr/share/nginx/html

# Drop the Docker/deployment files so they are never served.
RUN rm -f /usr/share/nginx/html/Dockerfile \
          /usr/share/nginx/html/docker-compose.yml \
          /usr/share/nginx/html/.dockerignore

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
