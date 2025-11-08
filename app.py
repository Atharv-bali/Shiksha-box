from flask import Flask, jsonify, render_template, request
import docker

app = Flask(__name__)
client = docker.from_env()

@app.route('/')
def index():
    return render_template('index.html')

# List all student containers
@app.route('/containers', methods=['GET'])
def list_containers():
    containers = []
    for c in client.containers.list(all=True):
        try:
            image_name = c.image.tags[0] if c.image.tags else 'untagged'
        except Exception:
            image_name = 'unknown'  # Fallback if image not found

        containers.append({
            'id': c.short_id,
            'name': c.name,
            'status': c.status,
            'image': image_name,
        })
    return jsonify(containers)


# Create a new student container with wettyoss/wetty
@app.route('/start_container', methods=['POST'])
def start_container():
    data = request.get_json()
    name = data.get('name', f'student_{len(client.containers.list(all=True)) + 1}')
    port = 5050 + len(client.containers.list())

    try:
        container = client.containers.run(
            image='wettyoss/wetty',
            name=name,
            detach=True,
            tty=True,
            ports={'3000/tcp': port},
            command=["yarn", "start", "--", "--command", "/bin/sh"],  # 👈 key change
            environment=["WETTY_BASE=/"]
        )
        return jsonify({
            'success': True,
            'id': container.short_id,
            'name': name,
            'port': port,
            'url': f'http://localhost:{port}'
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# container stats
@app.route('/container_stats/<string:container_id>', methods=['GET'])
def container_stats(container_id):
    try:
        container = client.containers.get(container_id)
        stats = container.stats(stream=False)

        # Calculate CPU %
        cpu_delta = stats['cpu_stats']['cpu_usage']['total_usage'] - stats['precpu_stats']['cpu_usage']['total_usage']
        system_delta = stats['cpu_stats']['system_cpu_usage'] - stats['precpu_stats']['system_cpu_usage']
        num_cpus = len(stats['cpu_stats']['cpu_usage'].get('percpu_usage', [])) or 1
        cpu_percent = (cpu_delta / system_delta) * num_cpus * 100.0 if system_delta > 0 and cpu_delta > 0 else 0.0

        # Memory in MB
        mem_usage = stats['memory_stats']['usage'] / 1024 ** 2

        return jsonify({
            'success': True,
            'cpu': round(cpu_percent, 2),
            'memory': round(mem_usage, 2)
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# Restart a stopped container
@app.route('/restart_container/<string:container_id>', methods=['POST'])
def restart_container(container_id):
    import docker
    try:
        container = client.containers.get(container_id)
        container.reload()

        # Handle all possible states
        if container.status == 'exited':
            container.start()
            msg = f"Container {container.name} started successfully."
        elif container.status == 'running':
            container.restart()
            msg = f"Container {container.name} restarted successfully."
        elif container.status in ['paused', 'created']:
            container.start()
            msg = f"Container {container.name} resumed successfully."
        else:
            container.start()
            msg = f"Container {container.name} started."

        return jsonify({'success': True, 'message': msg})

    except docker.errors.NotFound:
        return jsonify({'success': False, 'error': 'Container not found. Please refresh list.'}), 404
    except docker.errors.APIError as e:
        return jsonify({'success': False, 'error': f'Docker API error: {e.explanation}'})
    except PermissionError:
        return jsonify({'success': False, 'error': 'Permission denied to access Docker socket.'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


# Stop a container
@app.route('/stop_container/<string:container_id>', methods=['POST'])
def stop_container(container_id):
    try:
        container = client.containers.get(container_id)
        container.stop()
        return jsonify({'success': True, 'message': f'Container {container_id} stopped'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# Remove a container
@app.route('/remove_container/<string:container_id>', methods=['DELETE'])
def remove_container(container_id):
    try:
        container = client.containers.get(container_id)
        container.remove(force=True)
        return jsonify({'success': True, 'message': f'Container {container_id} removed'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
