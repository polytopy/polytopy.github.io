const canvas = document.getElementById('robots');
const ctx = canvas.getContext('2d');

const GRID_SIZE = 100;
const ROBOT_SIZE = 20;
const MOVE_SPEED = 2;

let robots = [];
let selectedRobot = null;

// Robot colors
const ROBOT_COLORS = [
    '#ea4335', '#ea4335', '#34a853', '#34a853',
    '#4285f4', '#4285f4', '#fbbc05', '#fbbc05'
];

const resizeObserver = new ResizeObserver(() => {
    canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
    canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
    // Clear and re-add all robots
    robots = [];
    selectedRobot = null;
    for (let i = 0; i < 8; i++) {
        addRobot();
    }
});
resizeObserver.observe(canvas);

class Robot {
    constructor(x, y, color) {
        this.x = x;
        this.y = y;
        this.targetX = x;
        this.targetY = y;
        this.color = color;
        this.path = [];
        this.currentPathIndex = 0;
        this.isMoving = false;
        this.isWaiting = false;
        this.selected = false;
        this.waitTimer = 0;
        this.blockedTimer = 0;
        this.lastBlockingRobot = null;
        this.stuckCounter = 0;
        this.lastPosition = {x: x, y: y};
        
        // Set initial random destination
        this.setRandomDestination();
    }
    
    setDestination(targetX, targetY) {
        // Ensure target is on valid grid intersection
        targetX = Math.round(targetX / GRID_SIZE) * GRID_SIZE;
        targetY = Math.round(targetY / GRID_SIZE) * GRID_SIZE;
        
        // Clamp to canvas bounds
        targetX = Math.max(0, Math.min(targetX, Math.floor(canvas.width / GRID_SIZE) * GRID_SIZE));
        targetY = Math.max(0, Math.min(targetY, Math.floor(canvas.height / GRID_SIZE) * GRID_SIZE));
        
        this.path = this.findPath(this.x, this.y, targetX, targetY);
        this.currentPathIndex = 0;
        this.isMoving = true;
        this.isWaiting = false;
        this.waitTimer = 0;
        this.blockedTimer = 0;
    }
    
    setRandomDestination() {
        let attempts = 0;
        let targetX, targetY;
        
        do {
            targetX = Math.floor(Math.random() * (Math.floor(canvas.width / GRID_SIZE) + 1)) * GRID_SIZE;
            targetY = Math.floor(Math.random() * (Math.floor(canvas.height / GRID_SIZE) + 1)) * GRID_SIZE;
            attempts++;
        } while ((targetX === this.x && targetY === this.y) && attempts < 10);
        
        this.setDestination(targetX, targetY);
    }
    
    findPath(startX, startY, endX, endY) {
        const path = [];
        let currentX = startX;
        let currentY = startY;
        
        // Ensure all coordinates are on grid
        startX = Math.round(startX / GRID_SIZE) * GRID_SIZE;
        startY = Math.round(startY / GRID_SIZE) * GRID_SIZE;
        endX = Math.round(endX / GRID_SIZE) * GRID_SIZE;
        endY = Math.round(endY / GRID_SIZE) * GRID_SIZE;
        
        currentX = startX;
        currentY = startY;
        
        // Manhattan pathfinding - move horizontally first, then vertically
        while (currentX !== endX) {
            if (currentX < endX) {
                currentX += GRID_SIZE;
            } else {
                currentX -= GRID_SIZE;
            }
            path.push({x: currentX, y: currentY});
        }
        
        while (currentY !== endY) {
            if (currentY < endY) {
                currentY += GRID_SIZE;
            } else {
                currentY -= GRID_SIZE;
            }
            path.push({x: currentX, y: currentY});
        }
        
        return path;
    }
    
    checkCollision(nextX, nextY) {
        for (let other of robots) {
            if (other === this) continue;
            
            const distance_squared = ((nextX - other.x) ** 2 + (nextY - other.y) ** 2);
            if (distance_squared < (ROBOT_SIZE * 1.5) ** 2) {
                return other;
            }
        }
        return null;
    }
    
    findEmergencyPath() {
        // Find any nearby empty spot to move to
        const emergencyOptions = [];
        const currentGridX = Math.round(this.x / GRID_SIZE) * GRID_SIZE;
        const currentGridY = Math.round(this.y / GRID_SIZE) * GRID_SIZE;
        
        // Check all 4 directions
        const directions = [
            {x: currentGridX - GRID_SIZE, y: currentGridY},
            {x: currentGridX + GRID_SIZE, y: currentGridY},
            {x: currentGridX, y: currentGridY - GRID_SIZE},
            {x: currentGridX, y: currentGridY + GRID_SIZE}
        ];
        
        for (let dir of directions) {
            if (dir.x >= 0 && dir.x < canvas.width && dir.y >= 0 && dir.y < canvas.height) {
                const blocked = this.checkCollision(dir.x, dir.y);
                if (!blocked) {
                    emergencyOptions.push(dir);
                }
            }
        }
        
        if (emergencyOptions.length > 0) {
            // Choose random available direction
            const chosen = emergencyOptions[Math.floor(Math.random() * emergencyOptions.length)];
            return [{x: chosen.x, y: chosen.y}];
        }
        
        return [];
    }
    
    findAlternatePath(startX, startY, endX, endY, avoidX, avoidY) {
        const path = [];
        
        // Ensure all coordinates are on grid
        startX = Math.round(startX / GRID_SIZE) * GRID_SIZE;
        startY = Math.round(startY / GRID_SIZE) * GRID_SIZE;
        endX = Math.round(endX / GRID_SIZE) * GRID_SIZE;
        endY = Math.round(endY / GRID_SIZE) * GRID_SIZE;
        avoidX = Math.round(avoidX / GRID_SIZE) * GRID_SIZE;
        avoidY = Math.round(avoidY / GRID_SIZE) * GRID_SIZE;
        
        // If start and end are the same, return empty path
        if (startX === endX && startY === endY) {
            return path;
        }
        
        let currentX = startX;
        let currentY = startY;
        let stepCount = 0;
        const maxSteps = 50;
        
        // Determine if we should go around the obstacle by adding a detour
        const needsDetour = (
            (startX === avoidX && Math.abs(startY - avoidY) <= GRID_SIZE) ||
            (startY === avoidY && Math.abs(startX - avoidX) <= GRID_SIZE) ||
            (Math.abs(startX - avoidX) <= GRID_SIZE && Math.abs(startY - avoidY) <= GRID_SIZE)
        );
        
        if (needsDetour) {
            // Create a unique detour based on robot's position and target
            const detourOptions = [];
            
            // Try going around in different directions
            if (currentX > 0) detourOptions.push({x: currentX - GRID_SIZE, y: currentY}); // Left
            if (currentX < canvas.width - GRID_SIZE) detourOptions.push({x: currentX + GRID_SIZE, y: currentY}); // Right
            if (currentY > 0) detourOptions.push({x: currentX, y: currentY - GRID_SIZE}); // Up
            if (currentY < canvas.height - GRID_SIZE) detourOptions.push({x: currentX, y: currentY + GRID_SIZE}); // Down
            
            // Choose detour that moves away from the blocking robot
            let bestDetour = null;
            let maxDistanceSquared = 0;
            
            for (let option of detourOptions) {
                const distance_squared = ((option.x - avoidX) ** 2 + (option.y - avoidY) ** 2);
                if (distance_squared > maxDistanceSquared) {
                    maxDistanceSquared = distance_squared;
                    bestDetour = option;
                }
            }
            
            if (bestDetour) {
                path.push(bestDetour);
                currentX = bestDetour.x;
                currentY = bestDetour.y;
                stepCount++;
            }
        }
        
        // Now use the opposite movement pattern (vertical first instead of horizontal first)
        while (currentY !== endY && stepCount < maxSteps) {
            if (currentY < endY) {
                currentY += GRID_SIZE;
            } else {
                currentY -= GRID_SIZE;
            }
            path.push({x: currentX, y: currentY});
            stepCount++;
        }
        
        while (currentX !== endX && stepCount < maxSteps) {
            if (currentX < endX) {
                currentX += GRID_SIZE;
            } else {
                currentX -= GRID_SIZE;
            }
            path.push({x: currentX, y: currentY});
            stepCount++;
        }
        
        // If we hit the step limit, fall back to normal pathfinding
        if (stepCount >= maxSteps) {
            return this.findPath(startX, startY, endX, endY);
        }
        
        return path;
    }
    
    update() {
        // Check if robot is stuck (hasn't moved significantly)
        const positionChanged = Math.abs(this.x - this.lastPosition.x) > 1 || Math.abs(this.y - this.lastPosition.y) > 1;
        if (!positionChanged && this.isMoving) {
            this.stuckCounter++;
        } else {
            this.stuckCounter = 0;
            this.lastPosition = {x: this.x, y: this.y};
        }
        
        // Emergency unstuck procedure
        if (this.stuckCounter > 180) { // 3 seconds
            const emergencyPath = this.findEmergencyPath();
            if (emergencyPath.length > 0) {
                // Move to emergency position, then replan to original target
                const originalTarget = this.path.length > 0 ? this.path[this.path.length - 1] : null;
                this.path = emergencyPath;
                this.currentPathIndex = 0;
                this.stuckCounter = 0;
                this.blockedTimer = 0;
                
                // After emergency move, plan new path to original target
                if (originalTarget) {
                    setTimeout(() => {
                        if (this.currentPathIndex >= this.path.length) {
                            this.setDestination(originalTarget.x, originalTarget.y);
                        }
                    }, 500);
                }
            } else {
                // If no emergency path available, pick new random destination
                this.setRandomDestination();
                this.stuckCounter = 0;
            }
            return;
        }
        
        if (!this.isMoving || this.path.length === 0) {
            // If not moving and not waiting, set new random destination
            if (!this.isWaiting) {
                this.waitTimer++;
                if (this.waitTimer > 60) { // Wait 1 second at 60fps
                    if (!this.selected) {
                        this.setRandomDestination();
                    }
                    this.waitTimer = 0;
                }
            }
            return;
        }
        
        if (this.currentPathIndex >= this.path.length) {
            this.isMoving = false;
            this.isWaiting = false;
            this.waitTimer = 0;
            this.blockedTimer = 0;
            return;
        }
        
        const target = this.path[this.currentPathIndex];
        const dx = target.x - this.x;
        const dy = target.y - this.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        let nextX;
        let nextY;
        if (distance < MOVE_SPEED) {
            nextX = target.x;
            nextY = target.y;
        } else {
            const moveX = (dx / distance) * MOVE_SPEED;
            const moveY = (dy / distance) * MOVE_SPEED;
            nextX = this.x + moveX;
            nextY = this.y + moveY;
        }
            
        const blockingRobot = this.checkCollision(nextX, nextY);
        if (blockingRobot) {
            this.isWaiting = true;
            this.blockedTimer++;
            
            // If blocked for too long, try alternate path
            if (this.blockedTimer > 90) { // 1.5 seconds
                const finalTarget = this.path[this.path.length - 1];
                // Check if the blocking robot is also blocked (mutual block)
                if (blockingRobot.isWaiting && blockingRobot.blockedTimer > 60) {
                    // Use alternate pathfinding to avoid the blocking robot
                    this.path = this.findAlternatePath(this.x, this.y, finalTarget.x, finalTarget.y, blockingRobot.x, blockingRobot.y);
                    this.currentPathIndex = 0;
                    this.blockedTimer = 0;
                    this.isWaiting = false;
                } else {
                    // Regular repath
                    this.path = this.findPath(this.x, this.y, finalTarget.x, finalTarget.y);
                    this.currentPathIndex = 0;
                    this.blockedTimer = 0;
                    this.isWaiting = false;
                }
            }
        } else {
            this.x = nextX;
            this.y = nextY;
            this.isWaiting = false;
            this.blockedTimer = 0;
            if (distance < MOVE_SPEED) {
                this.currentPathIndex++;
            }
        }
    }
    
    draw() {
        const gridWidth = Math.round((canvas.width - (GRID_SIZE/2)) / GRID_SIZE);
        const gridHeight = Math.round((canvas.height - (GRID_SIZE/2)) / GRID_SIZE);
        const gridOffsetX = (canvas.width - (gridWidth * GRID_SIZE)) / 2;
        const gridOffsetY = (canvas.height - (gridHeight * GRID_SIZE)) / 2;
        
        // Draw robot body
        ctx.fillStyle = this.color;
        ctx.fillRect(gridOffsetX + this.x - ROBOT_SIZE/2, gridOffsetY + this.y - ROBOT_SIZE/2, ROBOT_SIZE, ROBOT_SIZE);
        
        // Draw selection glow
        if (this.selected) {
            ctx.strokeStyle = '#FFFF00';
            ctx.lineWidth = 3;
            ctx.strokeRect(gridOffsetX + this.x - ROBOT_SIZE/2 - 2, gridOffsetY + this.y - ROBOT_SIZE/2 - 2, ROBOT_SIZE + 4, ROBOT_SIZE + 4);
        }
        
        // Draw eyes
        ctx.fillStyle = 'white';
        const eyeSize = 3;
        const eyeOffset = 4;
        ctx.fillRect(gridOffsetX + this.x - eyeOffset, gridOffsetY + this.y - eyeOffset, eyeSize, eyeSize);
        ctx.fillRect(gridOffsetX + this.x + eyeOffset - eyeSize, gridOffsetY + this.y - eyeOffset, eyeSize, eyeSize);
        
        // Draw waiting indicator
        if (this.isWaiting) {
            ctx.fillStyle = 'red';
            ctx.beginPath();
            ctx.arc(gridOffsetX + this.x, gridOffsetY + this.y - ROBOT_SIZE/2, 3, 0, Math.PI * 2);
            ctx.fill();
        }
        
        // Draw path
        if (this.path.length > 0) {
            if (this.selected) ctx.globalAlpha = 1;
            else ctx.globalAlpha = 0.5;
            ctx.strokeStyle = this.color;
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            
            ctx.beginPath();
            ctx.moveTo(gridOffsetX + this.x, gridOffsetY + this.y);
            
            for (let i = this.currentPathIndex; i < this.path.length; i++) {
                ctx.lineTo(gridOffsetX + this.path[i].x, gridOffsetY + this.path[i].y);
            }
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;
        }
    }
}

function drawGrid() {
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    
    const gridWidth = Math.round((canvas.width - (GRID_SIZE/2)) / GRID_SIZE);
    const gridHeight = Math.round((canvas.height - (GRID_SIZE/2)) / GRID_SIZE);
    const gridOffsetX = (canvas.width - (gridWidth * GRID_SIZE)) / 2;
    const gridOffsetY = (canvas.height - (gridHeight * GRID_SIZE)) / 2;

    // Vertical lines
    for (let x = -1; x <= gridWidth+1; x += 1) {
        ctx.beginPath();
        ctx.moveTo(gridOffsetX + x * GRID_SIZE, 0);
        ctx.lineTo(gridOffsetX + x * GRID_SIZE, canvas.height);
        ctx.stroke();
    }
    
    // Horizontal lines
    for (let y = 0; y <= gridHeight; y += 1) {
        ctx.beginPath();
        ctx.moveTo(0, gridOffsetY + y * GRID_SIZE);
        ctx.lineTo(canvas.width, gridOffsetY + y * GRID_SIZE);
        ctx.stroke();
    }
    
    ctx.setLineDash([]);
    
    // Grid intersection points
    ctx.fillStyle = '#888';
    for (let x = 0; x <= gridWidth; x += 1) {
        for (let y = 0; y <= gridHeight; y += 1) {
            ctx.beginPath();
            ctx.arc(gridOffsetX + x * GRID_SIZE, gridOffsetY + y * GRID_SIZE, 3, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

function addRobot() {
    if (robots.length >= ROBOT_COLORS.length) return;
    
    let x, y;
    let attempts = 0;
    
    do {
        x = Math.floor(Math.random() * (Math.floor(canvas.width / GRID_SIZE) + 1)) * GRID_SIZE;
        y = Math.floor(Math.random() * (Math.floor(canvas.height / GRID_SIZE) + 1)) * GRID_SIZE;
        attempts++;
    } while (robots.some(robot => robot.x === x && robot.y === y) && attempts < 50);
    
    const color = ROBOT_COLORS[robots.length];
    robots.push(new Robot(x, y, color));
}

function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGrid();
    for (let robot of robots) {
        robot.update();
        robot.draw();
    }
    requestAnimationFrame(animate);
}

canvas.addEventListener('click', (e) => {
    const gridWidth = Math.round((canvas.width - (GRID_SIZE/2)) / GRID_SIZE);
    const gridHeight = Math.round((canvas.height - (GRID_SIZE/2)) / GRID_SIZE);
    const gridOffsetX = (canvas.width - (gridWidth * GRID_SIZE)) / 2;
    const gridOffsetY = (canvas.height - (gridHeight * GRID_SIZE)) / 2;
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left - gridOffsetX;
    const y = e.clientY - rect.top - gridOffsetY;

    // Check if clicking on a robot
    let clickedRobot = null;
    for (let robot of robots) {
        const distance_squared = ((x - robot.x) ** 2 + (y - robot.y) ** 2);
        if (distance_squared < ROBOT_SIZE ** 2) {
            clickedRobot = robot;
            break;
        }
    }
    
    if (clickedRobot) {
        robots.forEach(robot => robot.selected = false);
        clickedRobot.selected = true;
        selectedRobot = clickedRobot;
    } else if (selectedRobot) {
        selectedRobot.setDestination(x, y);
        selectedRobot.selected = false;
        selectedRobot = null;
    }
});

// Initialize
robots = [];
selectedRobot = null;
// There should be either 4 or 8 robots.
// Colours: --red: #ea4335;
// Colours: --green: #34a853;
// Colours: --blue: #4285f4;
// Colours: --yellow: #fbbc05;
for (let i = 0; i < 8; i++) {
    addRobot();
}

animate();